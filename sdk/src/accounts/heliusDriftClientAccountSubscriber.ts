import {
	DataAndSlot,
	DelistedMarketSetting,
	DriftClientAccountEvents,
	DriftClientAccountSubscriber,
	NotSubscribedError,
	ResubOpts,
} from './types';
import {
	isVariant,
	PerpMarketAccount,
	SpotMarketAccount,
	StateAccount,
} from '../types';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import {
	getDriftStateAccountPublicKey,
	getPerpMarketPublicKey,
	getSpotMarketPublicKey,
} from '../addresses/pda';
import { Commitment, PublicKey } from '@solana/web3.js';
import { OracleInfo, OraclePriceData } from '../oracles/types';
import { OracleClientCache } from '../oracles/oracleClientCache';
import { QUOTE_ORACLE_PRICE_DATA } from '../oracles/quoteAssetOracleClient';
import { findAllMarketAndOracles } from '../config';
import { findDelistedPerpMarketsAndOracles } from './utils';
import { getOracleId } from '../oracles/oracleId';
import { OracleSource } from '../types';
import WebSocket from 'ws';

const ORACLE_DEFAULT_ID = getOracleId(
	PublicKey.default,
	OracleSource.QUOTE_ASSET
);

// Max subscriptions per WebSocket connection (leaving headroom under 100 limit)
const MAX_SUBSCRIPTIONS_PER_CONNECTION = 80;

/**
 * Account notification from Helius Enhanced WebSocket
 */
interface HeliusAccountNotification {
	jsonrpc: string;
	method: string;
	params: {
		result: {
			context: {
				slot: number;
			};
			value: {
				lamports: number;
				data: [string, string]; // [data, encoding]
				owner: string;
				executable: boolean;
				rentEpoch: number;
			};
		};
		subscription: number;
	};
}

/**
 * Subscription confirmation from Helius
 */
interface HeliusSubscriptionConfirmation {
	jsonrpc: string;
	result: number; // subscription ID
	id: number;
}

/**
 * Represents a single WebSocket connection in the pool
 */
interface PooledConnection {
	ws: WebSocket;
	subscriptionCount: number;
	subscriptionIdToAccount: Map<number, { type: string; pubkey: string; oracleInfo?: OracleInfo }>;
	pendingSubscriptions: Map<number, {
		resolve: (id: number) => void;
		reject: (err: Error) => void;
		type: string;
		pubkey: string;
		oracleInfo?: OracleInfo;
	}>;
	nextRequestId: number;
	pingInterval?: ReturnType<typeof setInterval>;
}

/**
 * HeliusDriftClientAccountSubscriber
 *
 * Uses Helius Enhanced WebSockets for faster, more reliable account subscriptions.
 * Enhanced WebSockets are 1.5-2x faster than standard WebSockets and are powered
 * by the same infrastructure as LaserStream.
 *
 * Key features:
 * - WebSocket connection pooling: opens multiple connections when needed
 * - ~80 subscriptions per connection (under 100 limit)
 * - Automatic ping/pong to keep connections alive (30s interval)
 * - Reconnection with exponential backoff
 *
 * Requirements:
 * - The program provider must use a Helius RPC URL (mainnet.helius-rpc.com or devnet.helius-rpc.com)
 * - Will throw an error if a non-Helius URL is detected
 */
export class HeliusDriftClientAccountSubscriber
	implements DriftClientAccountSubscriber {
	isSubscribed: boolean;
	program: Program;
	commitment: string;
	perpMarketIndexes: number[];
	spotMarketIndexes: number[];
	oracleInfos: OracleInfo[];
	oracleClientCache = new OracleClientCache();

	resubOpts?: ResubOpts;
	shouldFindAllMarketsAndOracles: boolean;

	eventEmitter: StrictEventEmitter<EventEmitter, DriftClientAccountEvents>;

	// Account data storage
	private stateAccountData?: DataAndSlot<StateAccount>;
	private perpMarketAccountData = new Map<number, DataAndSlot<PerpMarketAccount>>();
	private spotMarketAccountData = new Map<number, DataAndSlot<SpotMarketAccount>>();
	private oracleData = new Map<string, DataAndSlot<OraclePriceData>>();

	// Oracle maps
	perpOracleMap = new Map<number, PublicKey>();
	perpOracleStringMap = new Map<number, string>();
	spotOracleMap = new Map<number, PublicKey>();
	spotOracleStringMap = new Map<number, string>();

	delistedMarketSetting: DelistedMarketSetting;

	// Helius WebSocket pool
	private heliusWsEndpoint: string;
	private connectionPool: PooledConnection[] = [];

	// Account tracking
	private statePublicKey?: PublicKey;
	private perpMarketPublicKeys = new Map<string, number>(); // pubkey -> marketIndex
	private spotMarketPublicKeys = new Map<string, number>(); // pubkey -> marketIndex
	private oraclePublicKeys = new Map<string, OracleInfo>(); // pubkey -> OracleInfo

	// Connection management
	private reconnectAttempts = 0;
	private maxReconnectAttempts = 10;
	private baseReconnectDelay = 1000;
	private totalSubscriptionCount = 0;
	private isReconnecting = false;

	protected isSubscribing = false;
	protected subscriptionPromise: Promise<boolean>;
	protected subscriptionPromiseResolver: (val: boolean) => void;

	/**
	 * Constructor matching the standard DriftClientAccountSubscriber signature.
	 * Automatically derives the Helius Enhanced WebSocket endpoint from the program's RPC URL.
	 *
	 * @throws Error if the RPC URL is not a Helius URL
	 */
	public constructor(
		program: Program,
		perpMarketIndexes: number[],
		spotMarketIndexes: number[],
		oracleInfos: OracleInfo[],
		shouldFindAllMarketsAndOracles: boolean,
		delistedMarketSetting: DelistedMarketSetting,
		resubOpts?: ResubOpts,
		commitment?: Commitment
	) {
		this.isSubscribed = false;
		this.program = program;
		this.eventEmitter = new EventEmitter();
		this.perpMarketIndexes = perpMarketIndexes;
		this.spotMarketIndexes = spotMarketIndexes;
		this.oracleInfos = oracleInfos;
		this.shouldFindAllMarketsAndOracles = shouldFindAllMarketsAndOracles;
		this.delistedMarketSetting = delistedMarketSetting;
		this.resubOpts = resubOpts;
		this.commitment = commitment ?? 'confirmed';

		// Get RPC URL and validate it's a Helius URL
		const rpcUrl = (this.program.provider as AnchorProvider).connection.rpcEndpoint;
		if (!this.verifyHeliusRpcUrl(rpcUrl)) {
			throw new Error(
				`HeliusDriftClientAccountSubscriber requires a Helius RPC URL. ` +
				`Got: ${rpcUrl}. ` +
				`Please use a Helius RPC URL (e.g., https://mainnet.helius-rpc.com/?api-key=YOUR_KEY)`
			);
		}
		this.heliusWsEndpoint = rpcUrl;
	}

	/**
	 * Convert a Helius RPC URL to the Enhanced WebSocket endpoint.
	 * Validates that the URL is a Helius URL.
	 */
	private verifyHeliusRpcUrl(rpcUrl: string): boolean {
		const url = new URL(rpcUrl);

		// Check if it's a Helius URL
		if (!url.hostname.includes('helius-rpc.com') && !url.hostname.includes('helius.dev')) {
			return false;
		}
		return true;
	}

	/**
	 * Create a new pooled WebSocket connection
	 */
	private async createPooledConnection(): Promise<PooledConnection> {
		return new Promise((resolve, reject) => {
			if (this.resubOpts?.logResubMessages) {
				const maskedUrl = this.heliusWsEndpoint.replace(/api-key=[^&]+/, 'api-key=***');
				console.log(`[HeliusDriftClientAccountSubscriber] Opening new pooled connection to ${maskedUrl} (pool size: ${this.connectionPool.length + 1})`);
			}

			const ws = new WebSocket(this.heliusWsEndpoint);
			const pooledConn: PooledConnection = {
				ws,
				subscriptionCount: 0,
				subscriptionIdToAccount: new Map(),
				pendingSubscriptions: new Map(),
				nextRequestId: 1,
			};

			ws.on('open', () => {
				if (this.resubOpts?.logResubMessages) {
					console.log(`[HeliusDriftClientAccountSubscriber] Pooled connection ${this.connectionPool.length} opened`);
				}
				this.startPingForConnection(pooledConn);
				resolve(pooledConn);
			});

			ws.on('message', (data: WebSocket.Data) => {
				this.handleMessage(pooledConn, data);
			});

			ws.on('error', (error: Error) => {
				console.error('[HeliusDriftClientAccountSubscriber] WebSocket error:', error);
				if (!this.isSubscribed) {
					reject(error);
				}
			});

			ws.on('close', () => {
				if (this.resubOpts?.logResubMessages) {
					console.log('[HeliusDriftClientAccountSubscriber] Pooled connection closed');
				}
				this.stopPingForConnection(pooledConn);
				if (this.isSubscribed && !this.isReconnecting) {
					this.handleReconnect();
				}
			});

			ws.on('pong', () => {
				if (this.resubOpts?.logResubMessages) {
					console.debug('[HeliusDriftClientAccountSubscriber] Pong received');
				}
			});
		});
	}

	/**
	 * Get or create a connection with available subscription slots
	 */
	private async getAvailableConnection(): Promise<PooledConnection> {
		// Find a connection with room for more subscriptions
		for (const conn of this.connectionPool) {
			if (conn.subscriptionCount < MAX_SUBSCRIPTIONS_PER_CONNECTION && conn.ws.readyState === WebSocket.OPEN) {
				return conn;
			}
		}

		// No available connection, create a new one
		const newConn = await this.createPooledConnection();
		this.connectionPool.push(newConn);
		return newConn;
	}

	/**
	 * Start ping interval for a connection
	 */
	private startPingForConnection(conn: PooledConnection): void {
		this.stopPingForConnection(conn);
		conn.pingInterval = setInterval(() => {
			if (conn.ws?.readyState === WebSocket.OPEN) {
				conn.ws.ping();
			}
		}, 30000);
	}

	/**
	 * Stop ping interval for a connection
	 */
	private stopPingForConnection(conn: PooledConnection): void {
		if (conn.pingInterval) {
			clearInterval(conn.pingInterval);
			conn.pingInterval = undefined;
		}
	}

	/**
	 * Handle reconnection with exponential backoff
	 */
	private async handleReconnect(): Promise<void> {
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			console.error('[HeliusDriftClientAccountSubscriber] Max reconnection attempts reached');
			this.eventEmitter.emit('error', new Error('Max reconnection attempts reached'));
			return;
		}

		this.isReconnecting = true;
		this.reconnectAttempts++;
		const delay = this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

		if (this.resubOpts?.logResubMessages) {
			console.log(`[HeliusDriftClientAccountSubscriber] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
		}

		await new Promise((resolve) => setTimeout(resolve, delay));

		try {
			// Close all existing connections
			for (const conn of this.connectionPool) {
				this.stopPingForConnection(conn);
				if (conn.ws.readyState === WebSocket.OPEN) {
					conn.ws.close();
				}
			}
			this.connectionPool = [];
			this.totalSubscriptionCount = 0;

			// Resubscribe to all accounts
			await this.subscribeToAllAccounts();
			this.reconnectAttempts = 0;
			this.isReconnecting = false;
		} catch (error) {
			console.error('[HeliusDriftClientAccountSubscriber] Reconnection failed:', error);
			this.handleReconnect();
		}
	}

	/**
	 * Handle incoming WebSocket message
	 */
	private handleMessage(conn: PooledConnection, data: WebSocket.Data): void {
		try {
			const message = JSON.parse(data.toString());

			// Handle subscription confirmation
			if ('result' in message && typeof message.result === 'number') {
				const confirmation = message as HeliusSubscriptionConfirmation;
				const pending = conn.pendingSubscriptions.get(confirmation.id);
				if (pending) {
					// Store the subscription mapping
					conn.subscriptionIdToAccount.set(confirmation.result, {
						type: pending.type,
						pubkey: pending.pubkey,
						oracleInfo: pending.oracleInfo,
					});
					pending.resolve(confirmation.result);
					conn.pendingSubscriptions.delete(confirmation.id);
				}
				return;
			}

			// Handle account notification
			if (message.method === 'accountNotification') {
				this.handleAccountNotification(conn, message as HeliusAccountNotification);
			}
		} catch (error) {
			console.error('[HeliusDriftClientAccountSubscriber] Error parsing message:', error);
		}
	}

	/**
	 * Handle account notification - direct account data, no fetching needed
	 */
	private handleAccountNotification(conn: PooledConnection, notification: HeliusAccountNotification): void {
		const subscriptionId = notification.params.subscription;
		const accountInfo = conn.subscriptionIdToAccount.get(subscriptionId);

		if (!accountInfo) {
			if (this.resubOpts?.logResubMessages) {
				console.warn(`[HeliusDriftClientAccountSubscriber] Unknown subscription ID: ${subscriptionId}`);
			}
			return;
		}

		const { type, oracleInfo } = accountInfo;
		const slot = notification.params.result.context.slot;
		const [dataStr, encoding] = notification.params.result.value.data;

		let buffer: Buffer;
		if (encoding === 'base64') {
			buffer = Buffer.from(dataStr, 'base64');
		} else if (encoding === 'base58') {
			const bs58 = require('bs58');
			buffer = Buffer.from(bs58.decode(dataStr));
		} else {
			console.error(`[HeliusDriftClientAccountSubscriber] Unknown encoding: ${encoding}`);
			return;
		}

		// Process based on account type
		switch (type) {
			case 'state':
				this.processStateUpdate(buffer, slot);
				break;
			case 'perpMarket':
				this.processPerpMarketUpdate(buffer, slot);
				break;
			case 'spotMarket':
				this.processSpotMarketUpdate(buffer, slot);
				break;
			case 'oracle':
				if (oracleInfo) {
					this.processOracleUpdate(oracleInfo, buffer, slot);
				}
				break;
		}
	}

	private processStateUpdate(data: Buffer, slot: number): void {
		try {
			const stateData = this.program.account.state.coder.accounts.decode('State', data) as StateAccount;
			const existing = this.stateAccountData;
			if (!existing || slot >= existing.slot) {
				this.stateAccountData = { data: stateData, slot };
				this.eventEmitter.emit('stateAccountUpdate', stateData);
				this.eventEmitter.emit('update');
			}
		} catch (error) {
			console.error('[HeliusDriftClientAccountSubscriber] Error processing state update:', error);
		}
	}

	private processPerpMarketUpdate(data: Buffer, slot: number): void {
		try {
			const marketData = this.program.account.perpMarket.coder.accounts.decodeUnchecked('PerpMarket', data) as PerpMarketAccount;
			if (this.delistedMarketSetting !== DelistedMarketSetting.Subscribe && isVariant(marketData.status, 'delisted')) {
				return;
			}
			const existing = this.perpMarketAccountData.get(marketData.marketIndex);
			if (!existing || slot >= existing.slot) {
				this.perpMarketAccountData.set(marketData.marketIndex, { data: marketData, slot });
				this.eventEmitter.emit('perpMarketAccountUpdate', marketData);
				this.eventEmitter.emit('update');
			}
		} catch (error) {
			console.error('[HeliusDriftClientAccountSubscriber] Error processing perp market update:', error);
		}
	}

	private processSpotMarketUpdate(data: Buffer, slot: number): void {
		try {
			const marketData = this.program.account.spotMarket.coder.accounts.decodeUnchecked('SpotMarket', data) as SpotMarketAccount;
			if (this.delistedMarketSetting !== DelistedMarketSetting.Subscribe && isVariant(marketData.status, 'delisted')) {
				return;
			}
			const existing = this.spotMarketAccountData.get(marketData.marketIndex);
			if (!existing || slot >= existing.slot) {
				this.spotMarketAccountData.set(marketData.marketIndex, { data: marketData, slot });
				this.eventEmitter.emit('spotMarketAccountUpdate', marketData);
				this.eventEmitter.emit('update');
			}
		} catch (error) {
			console.error('[HeliusDriftClientAccountSubscriber] Error processing spot market update:', error);
		}
	}

	private processOracleUpdate(oracleInfo: OracleInfo, data: Buffer, slot: number): void {
		try {
			const oracleId = getOracleId(oracleInfo.publicKey, oracleInfo.source);
			const client = this.oracleClientCache.get(
				oracleInfo.source,
				this.program.provider.connection,
				this.program
			);
			const oraclePriceData = client.getOraclePriceDataFromBuffer(data);
			const existing = this.oracleData.get(oracleId);
			if (!existing || slot >= existing.slot) {
				this.oracleData.set(oracleId, { data: oraclePriceData, slot });
				this.eventEmitter.emit('oraclePriceUpdate', oracleInfo.publicKey, oracleInfo.source, oraclePriceData);
				this.eventEmitter.emit('update');
			}
		} catch (error) {
			console.error('[HeliusDriftClientAccountSubscriber] Error processing oracle update:', error);
		}
	}

	/**
	 * Subscribe to a single account via accountSubscribe
	 */
	private async subscribeToAccount(pubkey: string, type: string, oracleInfo?: OracleInfo): Promise<number> {
		const conn = await this.getAvailableConnection();

		return new Promise((resolve, reject) => {
			if (conn.ws.readyState !== WebSocket.OPEN) {
				reject(new Error('WebSocket not connected'));
				return;
			}

			const requestId = conn.nextRequestId++;
			const request = {
				jsonrpc: '2.0',
				id: requestId,
				method: 'accountSubscribe',
				params: [
					pubkey,
					{
						encoding: 'base64',
						commitment: this.commitment,
					},
				],
			};

			conn.pendingSubscriptions.set(requestId, {
				resolve: (id: number) => {
					conn.subscriptionCount++;
					this.totalSubscriptionCount++;
					console.log(`[HeliusDriftClientAccountSubscriber] Subscribed to ${type} (${pubkey.slice(0, 8)}...) - total: ${this.totalSubscriptionCount}, conn ${this.connectionPool.indexOf(conn)}: ${conn.subscriptionCount}/${MAX_SUBSCRIPTIONS_PER_CONNECTION}`);
					resolve(id);
				},
				reject,
				type,
				pubkey,
				oracleInfo,
			});

			conn.ws.send(JSON.stringify(request));

			// Timeout for subscription confirmation
			setTimeout(() => {
				if (conn.pendingSubscriptions.has(requestId)) {
					conn.pendingSubscriptions.delete(requestId);
					reject(new Error(`Subscription timeout for ${pubkey}`));
				}
			}, 10000);
		});
	}

	public async subscribe(): Promise<boolean> {
		try {
			const startTime = performance.now();

			if (this.isSubscribed) {
				return true;
			}

			if (this.isSubscribing) {
				return await this.subscriptionPromise;
			}

			this.isSubscribing = true;
			this.subscriptionPromiseResolver = () => { };
			this.subscriptionPromise = new Promise((res) => {
				this.subscriptionPromiseResolver = res;
			});

			// Find all markets and oracles if needed
			if (this.shouldFindAllMarketsAndOracles) {
				const {
					perpMarketIndexes,
					perpMarketAccounts,
					spotMarketIndexes,
					spotMarketAccounts,
					oracleInfos,
				} = await findAllMarketAndOracles(this.program);
				this.perpMarketIndexes = perpMarketIndexes;
				this.spotMarketIndexes = spotMarketIndexes;
				this.oracleInfos = oracleInfos;

				// Pre-populate with initial data
				for (const market of perpMarketAccounts) {
					this.perpMarketAccountData.set(market.marketIndex, { data: market, slot: 0 });
				}
				for (const market of spotMarketAccounts) {
					this.spotMarketAccountData.set(market.marketIndex, { data: market, slot: 0 });
				}
			}

			// Subscribe to all accounts (will create pooled connections as needed)
			await this.subscribeToAllAccounts();

			// Fetch initial data for all accounts
			await this.fetch();

			// Handle delisted market oracles
			await this.handleDelistedMarketOracles();

			// Set oracle maps
			await Promise.all([this.setPerpOracleMap(), this.setSpotOracleMap()]);

			this.eventEmitter.emit('update');

			const totalSubscriptions = this.connectionPool.reduce((sum, conn) => sum + conn.subscriptionCount, 0);
			const totalDuration = performance.now() - startTime;
			console.log(`[PROFILING] HeliusDriftClientAccountSubscriber.subscribe() completed in ${totalDuration.toFixed(2)}ms with ${totalSubscriptions} subscriptions across ${this.connectionPool.length} connections`);

			this.isSubscribed = true;
			this.isSubscribing = false;
			this.subscriptionPromiseResolver(true);

			return true;
		} catch (error) {
			console.error('[HeliusDriftClientAccountSubscriber] Subscription failed:', error);
			this.isSubscribing = false;
			this.subscriptionPromiseResolver(false);
			return false;
		}
	}

	/**
	 * Subscribe to all accounts using pooled connections
	 */
	private async subscribeToAllAccounts(): Promise<void> {
		const accountsToSubscribe: { pubkey: string; type: string; oracleInfo?: OracleInfo }[] = [];

		// State account
		this.statePublicKey = await getDriftStateAccountPublicKey(this.program.programId);
		accountsToSubscribe.push({ pubkey: this.statePublicKey.toBase58(), type: 'state' });

		// Perp market accounts
		for (const marketIndex of this.perpMarketIndexes) {
			const pubkey = await getPerpMarketPublicKey(this.program.programId, marketIndex);
			const pubkeyStr = pubkey.toBase58();
			this.perpMarketPublicKeys.set(pubkeyStr, marketIndex);
			accountsToSubscribe.push({ pubkey: pubkeyStr, type: 'perpMarket' });
		}

		// Spot market accounts
		for (const marketIndex of this.spotMarketIndexes) {
			const pubkey = await getSpotMarketPublicKey(this.program.programId, marketIndex);
			const pubkeyStr = pubkey.toBase58();
			this.spotMarketPublicKeys.set(pubkeyStr, marketIndex);
			accountsToSubscribe.push({ pubkey: pubkeyStr, type: 'spotMarket' });
		}

		// Oracle accounts
		for (const oracleInfo of this.oracleInfos) {
			if (oracleInfo.publicKey.equals(PublicKey.default)) continue;
			const pubkeyStr = oracleInfo.publicKey.toBase58();
			this.oraclePublicKeys.set(pubkeyStr, oracleInfo);
			accountsToSubscribe.push({ pubkey: pubkeyStr, type: 'oracle', oracleInfo });
		}

		if (this.resubOpts?.logResubMessages) {
			console.log(`[HeliusDriftClientAccountSubscriber] Subscribing to ${accountsToSubscribe.length} accounts`);
		}

		// Subscribe in batches to respect connection limits
		// Process subscriptions in parallel within each connection's capacity
		const batchSize = MAX_SUBSCRIPTIONS_PER_CONNECTION;
		for (let i = 0; i < accountsToSubscribe.length; i += batchSize) {
			const batch = accountsToSubscribe.slice(i, i + batchSize);
			await Promise.all(
				batch.map((account) =>
					this.subscribeToAccount(account.pubkey, account.type, account.oracleInfo)
				)
			);
		}
	}

	public async fetch(): Promise<void> {
		const connection = this.program.provider.connection;

		// Build list of all pubkeys to fetch
		const allPubkeys: PublicKey[] = [];
		const pubkeyToType = new Map<string, { type: string; oracleInfo?: OracleInfo }>();

		if (this.statePublicKey) {
			allPubkeys.push(this.statePublicKey);
			pubkeyToType.set(this.statePublicKey.toBase58(), { type: 'state' });
		}

		for (const [pubkeyStr, _marketIndex] of this.perpMarketPublicKeys) {
			allPubkeys.push(new PublicKey(pubkeyStr));
			pubkeyToType.set(pubkeyStr, { type: 'perpMarket' });
		}

		for (const [pubkeyStr, _marketIndex] of this.spotMarketPublicKeys) {
			allPubkeys.push(new PublicKey(pubkeyStr));
			pubkeyToType.set(pubkeyStr, { type: 'spotMarket' });
		}

		for (const [pubkeyStr, oracleInfo] of this.oraclePublicKeys) {
			allPubkeys.push(new PublicKey(pubkeyStr));
			pubkeyToType.set(pubkeyStr, { type: 'oracle', oracleInfo });
		}

		// Fetch all accounts in batches
		const batchSize = 100;
		for (let i = 0; i < allPubkeys.length; i += batchSize) {
			const batch = allPubkeys.slice(i, i + batchSize);
			const accountInfos = await connection.getMultipleAccountsInfo(batch);

			for (let j = 0; j < batch.length; j++) {
				const pubkey = batch[j];
				const pubkeyStr = pubkey.toBase58();
				const accountInfo = accountInfos[j];
				const typeInfo = pubkeyToType.get(pubkeyStr);

				if (!accountInfo || !typeInfo) continue;

				switch (typeInfo.type) {
					case 'state': {
						const stateData = this.program.account.state.coder.accounts.decode('State', accountInfo.data) as StateAccount;
						this.stateAccountData = { data: stateData, slot: 0 };
						break;
					}
					case 'perpMarket': {
						const marketData = this.program.account.perpMarket.coder.accounts.decodeUnchecked('PerpMarket', accountInfo.data) as PerpMarketAccount;
						this.perpMarketAccountData.set(marketData.marketIndex, { data: marketData, slot: 0 });
						break;
					}
					case 'spotMarket': {
						const marketData = this.program.account.spotMarket.coder.accounts.decodeUnchecked('SpotMarket', accountInfo.data) as SpotMarketAccount;
						this.spotMarketAccountData.set(marketData.marketIndex, { data: marketData, slot: 0 });
						break;
					}
					case 'oracle': {
						if (typeInfo.oracleInfo) {
							const client = this.oracleClientCache.get(
								typeInfo.oracleInfo.source,
								connection,
								this.program
							);
							const oraclePriceData = client.getOraclePriceDataFromBuffer(accountInfo.data);
							const oracleId = getOracleId(typeInfo.oracleInfo.publicKey, typeInfo.oracleInfo.source);
							this.oracleData.set(oracleId, { data: oraclePriceData, slot: 0 });
						}
						break;
					}
				}
			}
		}
	}

	public addPerpMarket(_marketIndex: number): Promise<boolean> {
		return Promise.resolve(true);
	}

	public addSpotMarket(_marketIndex: number): Promise<boolean> {
		return Promise.resolve(true);
	}

	async addOracle(oracleInfo: OracleInfo): Promise<boolean> {
		const oracleId = getOracleId(oracleInfo.publicKey, oracleInfo.source);

		if (this.oracleData.has(oracleId)) {
			return true;
		}

		if (oracleInfo.publicKey.equals(PublicKey.default)) {
			return true;
		}

		try {
			const pubkeyStr = oracleInfo.publicKey.toBase58();
			this.oraclePublicKeys.set(pubkeyStr, oracleInfo);

			// Subscribe to the new oracle
			await this.subscribeToAccount(pubkeyStr, 'oracle', oracleInfo);

			// Fetch initial data
			const accountInfo = await this.program.provider.connection.getAccountInfo(oracleInfo.publicKey);
			if (accountInfo) {
				const client = this.oracleClientCache.get(
					oracleInfo.source,
					this.program.provider.connection,
					this.program
				);
				const data = client.getOraclePriceDataFromBuffer(accountInfo.data);
				this.oracleData.set(oracleId, { data, slot: 0 });
			}

			return true;
		} catch (error) {
			console.error(`[HeliusDriftClientAccountSubscriber] Failed to add oracle ${oracleInfo.publicKey.toString()}:`, error);
			return false;
		}
	}

	async setPerpOracleMap(): Promise<void> {
		const perpMarkets = this.getMarketAccountsAndSlots();
		const addOraclePromises = [];

		for (const perpMarket of perpMarkets) {
			if (!perpMarket?.data) continue;

			const perpMarketAccount = perpMarket.data;
			const perpMarketIndex = perpMarketAccount.marketIndex;
			const oracle = perpMarketAccount.amm.oracle;
			const oracleId = getOracleId(oracle, perpMarketAccount.amm.oracleSource);

			if (!this.oracleData.has(oracleId)) {
				addOraclePromises.push(
					this.addOracle({
						publicKey: oracle,
						source: perpMarketAccount.amm.oracleSource,
					})
				);
			}

			this.perpOracleMap.set(perpMarketIndex, oracle);
			this.perpOracleStringMap.set(perpMarketIndex, oracleId);
		}

		await Promise.all(addOraclePromises);
	}

	async setSpotOracleMap(): Promise<void> {
		const spotMarkets = this.getSpotMarketAccountsAndSlots();
		const addOraclePromises = [];

		for (const spotMarket of spotMarkets) {
			if (!spotMarket?.data) continue;

			const spotMarketAccount = spotMarket.data;
			const spotMarketIndex = spotMarketAccount.marketIndex;
			const oracle = spotMarketAccount.oracle;
			const oracleId = getOracleId(oracle, spotMarketAccount.oracleSource);

			if (!this.oracleData.has(oracleId)) {
				addOraclePromises.push(
					this.addOracle({
						publicKey: oracle,
						source: spotMarketAccount.oracleSource,
					})
				);
			}

			this.spotOracleMap.set(spotMarketIndex, oracle);
			this.spotOracleStringMap.set(spotMarketIndex, oracleId);
		}

		await Promise.all(addOraclePromises);
	}

	async handleDelistedMarketOracles(): Promise<void> {
		if (this.delistedMarketSetting === DelistedMarketSetting.Subscribe) {
			return;
		}

		const { oracles } = findDelistedPerpMarketsAndOracles(
			this.getMarketAccountsAndSlots(),
			this.getSpotMarketAccountsAndSlots()
		);

		for (const oracle of oracles) {
			const oracleId = getOracleId(oracle.publicKey, oracle.source);
			if (this.delistedMarketSetting === DelistedMarketSetting.Discard) {
				this.oracleData.delete(oracleId);
				this.oraclePublicKeys.delete(oracle.publicKey.toBase58());
			}
		}
	}

	public async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		// Unsubscribe and close all pooled connections
		for (const conn of this.connectionPool) {
			this.stopPingForConnection(conn);

			if (conn.ws.readyState === WebSocket.OPEN) {
				// Unsubscribe from all accounts on this connection
				for (const subscriptionId of conn.subscriptionIdToAccount.keys()) {
					conn.ws.send(JSON.stringify({
						jsonrpc: '2.0',
						id: conn.nextRequestId++,
						method: 'accountUnsubscribe',
						params: [subscriptionId],
					}));
				}
				conn.ws.close();
			}
		}

		this.connectionPool = [];
		this.totalSubscriptionCount = 0;
		this.isSubscribed = false;
		this.isSubscribing = false;
	}

	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	public getStateAccountAndSlot(): DataAndSlot<StateAccount> {
		this.assertIsSubscribed();
		return this.stateAccountData!;
	}

	public getMarketAccountAndSlot(marketIndex: number): DataAndSlot<PerpMarketAccount> | undefined {
		this.assertIsSubscribed();
		return this.perpMarketAccountData.get(marketIndex);
	}

	public getMarketAccountsAndSlots(): DataAndSlot<PerpMarketAccount>[] {
		return Array.from(this.perpMarketAccountData.values());
	}

	public getSpotMarketAccountAndSlot(marketIndex: number): DataAndSlot<SpotMarketAccount> | undefined {
		this.assertIsSubscribed();
		return this.spotMarketAccountData.get(marketIndex);
	}

	public getSpotMarketAccountsAndSlots(): DataAndSlot<SpotMarketAccount>[] {
		return Array.from(this.spotMarketAccountData.values());
	}

	public getOraclePriceDataAndSlot(oracleId: string): DataAndSlot<OraclePriceData> | undefined {
		this.assertIsSubscribed();
		if (oracleId === ORACLE_DEFAULT_ID) {
			return {
				data: QUOTE_ORACLE_PRICE_DATA,
				slot: 0,
			};
		}
		return this.oracleData.get(oracleId);
	}

	public getOraclePriceDataAndSlotForPerpMarket(marketIndex: number): DataAndSlot<OraclePriceData> | undefined {
		const perpMarketAccount = this.getMarketAccountAndSlot(marketIndex);
		const oracle = this.perpOracleMap.get(marketIndex);
		const oracleId = this.perpOracleStringMap.get(marketIndex);

		if (!perpMarketAccount || !oracleId) {
			return undefined;
		}

		if (!perpMarketAccount.data.amm.oracle.equals(oracle)) {
			this.setPerpOracleMap();
		}

		return this.getOraclePriceDataAndSlot(oracleId);
	}

	public getOraclePriceDataAndSlotForSpotMarket(marketIndex: number): DataAndSlot<OraclePriceData> | undefined {
		const spotMarketAccount = this.getSpotMarketAccountAndSlot(marketIndex);
		const oracle = this.spotOracleMap.get(marketIndex);
		const oracleId = this.spotOracleStringMap.get(marketIndex);

		if (!spotMarketAccount || !oracleId) {
			return undefined;
		}

		if (!spotMarketAccount.data.oracle.equals(oracle)) {
			this.setSpotOracleMap();
		}

		return this.getOraclePriceDataAndSlot(oracleId);
	}
}
