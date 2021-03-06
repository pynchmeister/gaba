import 'isomorphic-fetch';
import BaseController, { BaseConfig, BaseState } from './BaseController';
import AssetsController from './AssetsController';
import NetworkController from './NetworkController';
import PreferencesController from './PreferencesController';
import AssetsContractController from './AssetsContractController';
import { safelyExecute } from './util';
import { Token } from './TokenRatesController';
import { NetworkType } from './NetworkController';

const contractMap = require('eth-contract-metadata');
const DEFAULT_INTERVAL = 180000;
const MAINNET = 'mainnet';

/**
 * @type ApiCollectibleResponse
 *
 * Collectible object coming from OpenSea api
 *
 * @property token_id - The collectible identifier
 * @property image_preview_url - URI of collectible image associated with this collectible
 * @property name - The collectible name
 * @property description - The collectible description
 * @property assetContract - The collectible contract basic information, in this case the address
 */
export interface ApiCollectibleResponse {
	token_id: string;
	image_preview_url: string;
	name: string;
	description: string;
	asset_contract: { [address: string]: string };
}

/**
 * @type AssetsConfig
 *
 * Assets controller configuration
 *
 * @property interval - Polling interval used to fetch new token rates
 * @property networkType - Network type ID as per net_version
 * @property selectedAddress - Vault selected address
 * @property tokens - List of tokens associated with the active vault
 */
export interface AssetsDetectionConfig extends BaseConfig {
	interval: number;
	networkType: NetworkType;
	selectedAddress: string;
	tokens: Token[];
}

/**
 * Controller that passively polls on a set interval for assets auto detection
 */
export class AssetsDetectionController extends BaseController<AssetsDetectionConfig, BaseState> {
	private handle?: NodeJS.Timer;

	private getOwnerCollectiblesApi(address: string) {
		return `https://api.opensea.io/api/v1/assets?owner=${address}`;
	}

	private async getOwnerCollectibles() {
		const { selectedAddress } = this.config;
		const api = this.getOwnerCollectiblesApi(selectedAddress);
		const response = await fetch(api);
		const collectiblesArray = await response.json();
		const collectibles = collectiblesArray.assets;
		return collectibles;
	}

	/**
	 * Name of this controller used during composition
	 */
	name = 'AssetsDetectionController';

	/**
	 * List of required sibling controllers this controller needs to function
	 */
	requiredControllers = [
		'AssetsContractController',
		'AssetsController',
		'NetworkController',
		'PreferencesController'
	];

	/**
	 * Creates a AssetsDetectionController instance
	 *
	 * @param config - Initial options used to configure this controller
	 * @param state - Initial state to set on this controller
	 */
	constructor(config?: Partial<AssetsDetectionConfig>, state?: Partial<BaseState>) {
		super(config, state);
		this.defaultConfig = {
			interval: DEFAULT_INTERVAL,
			networkType: 'ropsten',
			selectedAddress: '',
			tokens: []
		};
		this.initialize();
	}

	/**
	 * Sets a new polling interval
	 *
	 * @param interval - Polling interval used to auto detect assets
	 */
	set interval(interval: number) {
		this.handle && clearInterval(this.handle);
		this.handle = setInterval(() => {
			safelyExecute(() => this.detectAssets());
		}, interval);
	}

	/**
	 * Checks whether network is mainnet or not
	 *
	 * @returns - Whether current network is mainnet
	 */
	isMainnet() {
		if (this.config.networkType !== MAINNET || this.disabled) {
			return false;
		}
		return true;
	}

	/**
	 * Detect assets owned by current account on mainnet
	 */
	async detectAssets() {
		/* istanbul ignore if */
		if (!this.isMainnet()) {
			return;
		}
		this.detectTokens();
		this.detectCollectibles();
	}

	/**
	 * Triggers asset ERC20 token auto detection for each contract address in contract metadata on mainnet
	 */
	async detectTokens() {
		/* istanbul ignore if */
		if (!this.isMainnet()) {
			return;
		}
		const tokensAddresses = this.config.tokens.filter(/* istanbul ignore next*/ (token) => token.address);
		const tokensToDetect = [];
		for (const address in contractMap) {
			const contract = contractMap[address];
			if (contract.erc20 && !(address in tokensAddresses)) {
				tokensToDetect.push(address);
			}
		}

		const assetsContractController = this.context.AssetsContractController as AssetsContractController;
		const { selectedAddress } = this.config;

		const balances = await assetsContractController.getBalancesInSingleCall(selectedAddress, tokensToDetect);
		const assetsController = this.context.AssetsController as AssetsController;
		for (const tokenAddress in balances) {
			await assetsController.addToken(
				tokenAddress,
				contractMap[tokenAddress].symbol,
				contractMap[tokenAddress].decimals
			);
		}
	}

	/**
	 * Triggers asset ERC721 token auto detection suing OpenSea on mainnet
	 */
	async detectCollectibles() {
		/* istanbul ignore if */
		if (!this.isMainnet()) {
			return;
		}
		const assetsController = this.context.AssetsController as AssetsController;
		const collectibles = await this.getOwnerCollectibles();
		const addCollectiblesPromises = collectibles.map(async (collectible: ApiCollectibleResponse) => {
			const {
				token_id,
				image_preview_url,
				name,
				description,
				asset_contract: { address }
			} = collectible;
			await assetsController.addCollectible(address, Number(token_id), {
				description,
				image: image_preview_url,
				name
			});
		});
		await Promise.all(addCollectiblesPromises);
	}

	/**
	 * Extension point called if and when this controller is composed
	 * with other controllers using a ComposableController
	 */
	onComposed() {
		super.onComposed();
		const preferences = this.context.PreferencesController as PreferencesController;
		const network = this.context.NetworkController as NetworkController;
		const assets = this.context.AssetsController as AssetsController;
		assets.subscribe(({ tokens }) => {
			this.configure({ tokens });
		});
		preferences.subscribe(({ selectedAddress }) => {
			const actualSelectedAddress = this.config.selectedAddress;
			if (selectedAddress !== actualSelectedAddress) {
				this.configure({ selectedAddress });
				this.detectAssets();
			}
		});
		network.subscribe(({ provider }) => {
			this.configure({ networkType: provider.type });
		});
	}
}

export default AssetsDetectionController;
