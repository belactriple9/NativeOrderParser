(() => {
	const outputEl = document.getElementById('output');
	const analyzeBtn = document.getElementById('analyzeButton');

	const ADDR_ROUTER_V6 = '0x111111125421cA6dc452d289314280a0f8842A65';
	const ADDR_ERC20_TRUE = '0xda0000d4000015a526378bb6fafc650cea5966f8';

	const SIG_SRC_ESCROW_CREATED = '0x0e534c62f0afd2fa0f0fa71198e8aa2d549f24daf2bb47de0d5486c7ce9288ca';
	const SELECTOR_POST_INTERACTION = '0x462ebde2';
	const SELECTOR_TRANSFER = '0xa9059cbb';
	const SELECTOR_TRANSFER_FROM = '0x23b872dd';

	const TOPIC_NATIVE_ORDER_CREATED = ethers.id('NativeOrderCreated(address,bytes32,address,uint256)');
	const TOPIC_ORDER_FILLED = ethers.id('OrderFilled(bytes32,uint256)');
	const TOPIC_TRANSFER = ethers.id('Transfer(address,address,uint256)');

	const ifaceCreate = new ethers.Interface([
		'function create((uint256 salt,uint256 maker,uint256 receiver,uint256 makerAsset,uint256 takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 makerTraits) makerOrder)'
	]);

	const ifaceNativeOrderCreatedA = new ethers.Interface([
		'event NativeOrderCreated(address maker, bytes32 orderHash, address clone, uint256 value)'
	]);
	const ifaceNativeOrderCreatedB = new ethers.Interface([
		'event NativeOrderCreated(address indexed maker, bytes32 indexed orderHash, address clone, uint256 value)'
	]);

	const ifacePostInteractionV4 = new ethers.Interface([
		'function postInteraction((uint256 salt,uint256 maker,uint256 receiver,uint256 makerAsset,uint256 takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 makerTraits) order, bytes extension, bytes32 orderHash, address taker, uint256 makingAmount, uint256 takingAmount, uint256 remainingMakingAmount, bytes extraData)'
	]);
	const ifacePostInteractionLegacy = new ethers.Interface([
		'function postInteraction((uint256 salt,address maker,address receiver,address makerAsset,address takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 makerTraits) order, bytes extension, bytes32 orderHash, address taker, uint256 makingAmount, uint256 takingAmount, uint256 remainingMakingAmount, bytes extraData)'
	]);

	const ifaceErc20 = new ethers.Interface([
		'function transfer(address to, uint256 value)',
		'function transferFrom(address from, address to, uint256 value)'
	]);

	const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

	function appendLine(message, className) {
		const div = document.createElement('div');
		if (className) div.className = className;
		div.textContent = message;
		outputEl.appendChild(div);
	}

	function appendError(message) {
		appendLine(message, 'error');
	}

	function resetOutput() {
		outputEl.textContent = '';
	}

	function toHex(num) {
		return '0x' + num.toString(16);
	}

	function hexToBigInt(wordHex) {
		const clean = wordHex.startsWith('0x') ? wordHex.slice(2) : wordHex;
		return BigInt('0x' + clean);
	}

	function low20FromWord(wordHex) {
		const clean = wordHex.startsWith('0x') ? wordHex.slice(2) : wordHex;
		return '0x' + clean.slice(-40).padStart(40, '0');
	}

	function splitDataIntoWords(dataHex) {
		const clean = dataHex.startsWith('0x') ? dataHex.slice(2) : dataHex;
		const words = [];
		for (let i = 0; i < clean.length; i += 64) {
			words.push(clean.slice(i, i + 64).padEnd(64, '0'));
		}
		return words;
	}

	function toAddressFromUint(uintValue) {
		const mask = (1n << 160n) - 1n;
		const low = uintValue & mask;
		const hex = low.toString(16).padStart(40, '0');
		return '0x' + hex;
	}

	function bigIntToDecimal(bi) {
		return bi.toString(10);
	}

	function parseLogIndex(logIndex) {
		if (typeof logIndex === 'number') return logIndex;
		return Number.parseInt(logIndex, 16);
	}

	function base58Encode(bytes) {
		if (bytes.length === 0) return '';
		let digits = [0];
		for (let i = 0; i < bytes.length; i++) {
			let carry = bytes[i];
			for (let j = 0; j < digits.length; j++) {
				const val = digits[j] * 256 + carry;
				digits[j] = val % 58;
				carry = Math.floor(val / 58);
			}
			while (carry > 0) {
				digits.push(carry % 58);
				carry = Math.floor(carry / 58);
			}
		}
		// handle leading zeros
		for (let k = 0; k < bytes.length && bytes[k] === 0; k++) {
			digits.push(0);
		}
		return digits.reverse().map((d) => BASE58_ALPHABET[d]).join('');
	}

	function bytesFromHex(hex) {
		const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
		if (clean.length % 2 !== 0) throw new Error('Invalid hex length');
		const out = new Uint8Array(clean.length / 2);
		for (let i = 0; i < out.length; i++) {
			out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
		}
		return out;
	}

	async function blockNumberAtOrAfterTimestamp(provider, targetTs) {
		let lo = 0;
		let hi = await provider.getBlockNumber();
		let answer = hi;
		while (lo <= hi) {
			const mid = Math.floor((lo + hi) / 2);
			const blk = await provider.getBlock(mid);
			if (!blk) {
				// If block unavailable, move lower bound up to avoid infinite loop
				lo = mid + 1;
				continue;
			}
			if (blk.timestamp >= targetTs) {
				answer = mid;
				hi = mid - 1;
			} else {
				lo = mid + 1;
			}
		}
		return answer;
	}

	async function batchedGetLogs(rpcUrl, address, topic0, fromBlock, toBlock, log) {
		const CHUNK = 25;
		const BATCH = 25;
		const filters = [];
		for (let b = fromBlock; b <= toBlock; b += CHUNK) {
			const end = Math.min(b + CHUNK - 1, toBlock);
			filters.push({
				address,
				topics: [topic0],
				fromBlock: toHex(b),
				toBlock: toHex(end)
			});
		}

		let id = 1;
		const allLogs = [];

		for (let i = 0; i < filters.length; i += BATCH) {
			const batch = filters.slice(i, i + BATCH);
			const body = batch.map((f) => ({
				jsonrpc: '2.0',
				id: id++,
				method: 'eth_getLogs',
				params: [f]
			}));
			try {
				const resp = await fetch(rpcUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body)
				});
				const json = await resp.json();
				if (!Array.isArray(json)) {
					log('Unexpected logs batch response');
					continue;
				}
				for (const item of json) {
					if (item.error) {
						log(`eth_getLogs error for range ${item.id}: ${item.error.message || 'unknown error'}`);
						continue;
					}
					if (Array.isArray(item.result)) {
						allLogs.push(...item.result);
					}
				}
			} catch (err) {
				log(`Batch request failed: ${err.message}`);
			}
		}

		return allLogs;
	}

	function findNativeOrderCreated(createReceipt) {
		if (!createReceipt || !Array.isArray(createReceipt.logs)) return null;
		for (const log of createReceipt.logs) {
			if (!log || !log.topics || log.topics.length === 0) continue;
			if (log.topics[0].toLowerCase() !== TOPIC_NATIVE_ORDER_CREATED.toLowerCase()) continue;

			try {
				if (log.topics.length === 1) {
					const decoded = ifaceNativeOrderCreatedA.decodeEventLog('NativeOrderCreated', log.data, log.topics);
					return {
						maker: decoded.maker,
						orderHash: decoded.orderHash,
						clone: decoded.clone,
						value: decoded.value
					};
				}

				if (log.topics.length >= 3) {
					const decoded = ifaceNativeOrderCreatedB.decodeEventLog('NativeOrderCreated', log.data, log.topics);
					return {
						maker: decoded.maker,
						orderHash: decoded.orderHash,
						clone: decoded.clone,
						value: decoded.value
					};
				}
			} catch (err) {
				// continue scanning other logs
			}
		}
		return null;
	}

	function decodeMakerTraitsExpiry(makerTraits) {
		const traits = BigInt(makerTraits);
		const expiry = (traits >> 80n) & ((1n << 40n) - 1n);
		return expiry;
	}

	function findFirstCallBySelector(callNode, selector) {
		if (!callNode) return null;
		const input = callNode.input || '';
		if (typeof input === 'string' && input.startsWith(selector)) {
			return callNode;
		}
		if (Array.isArray(callNode.calls)) {
			for (const child of callNode.calls) {
				const found = findFirstCallBySelector(child, selector);
				if (found) return found;
			}
		}
		return null;
	}

	function collectErc20TransfersInSubtree(callNode, tokenAddress) {
		const totals = new Map();
		const token = tokenAddress.toLowerCase();

		function visit(node) {
			if (!node) return;
			const to = (node.to || '').toLowerCase();
			const input = node.input || '';
			const inputLower = typeof input === 'string' ? input.toLowerCase() : '';
			if (to === token && typeof input === 'string' && input.length >= 10) {
				if (inputLower.startsWith(SELECTOR_TRANSFER)) {
					try {
						const [toAddr, value] = ifaceErc20.decodeFunctionData('transfer', input);
						const key = toAddr.toLowerCase();
						const prev = totals.get(key) || 0n;
						totals.set(key, prev + BigInt(value));
					} catch (err) {
						// ignore decode errors
					}
				} else if (inputLower.startsWith(SELECTOR_TRANSFER_FROM)) {
					try {
						const [, toAddr, value] = ifaceErc20.decodeFunctionData('transferFrom', input);
						const key = toAddr.toLowerCase();
						const prev = totals.get(key) || 0n;
						totals.set(key, prev + BigInt(value));
					} catch (err) {
						// ignore decode errors
					}
				}
			}

			if (Array.isArray(node.calls)) {
				for (const child of node.calls) visit(child);
			}
		}

		visit(callNode);
		return totals;
	}

	function decodeSrcEscrowCreated(logData) {
		const words = splitDataIntoWords(logData);
		if (words.length < 13) throw new Error('SrcEscrowCreated data too short');

		const src = {
			orderHash: '0x' + words[0],
			hashlock: '0x' + words[1],
			maker: hexToBigInt(words[2]),
			taker: hexToBigInt(words[3]),
			token: hexToBigInt(words[4]),
			amount: hexToBigInt(words[5]),
			safetyDeposit: hexToBigInt(words[6]),
			timelocks: hexToBigInt(words[7])
		};
		const dst = {
			maker: hexToBigInt(words[8]),
			amount: hexToBigInt(words[9]),
			token: hexToBigInt(words[10]),
			safetyDeposit: hexToBigInt(words[11]),
			chainId: hexToBigInt(words[12])
		};
		return { srcImmutables: src, dstImmutablesComplement: dst, rawWords: words };
	}

	function extractHigh12FromExtension(extensionHex) {
		const clean = extensionHex.startsWith('0x') ? extensionHex.slice(2) : extensionHex;
		return clean.slice(-24).padStart(24, '0');
	}

	function reconstructSolanaPubkeyHex(high12, low20) {
		return '0x' + (high12 + low20).padStart(64, '0');
	}

	function printRecipients(map, title) {
		if (!map || map.size === 0) {
			appendLine(`${title}: none`);
			return null;
		}
		const entries = Array.from(map.entries()).sort((a, b) => (b[1] > a[1] ? 1 : -1));
		appendLine(`${title}: top recipients`);
		const topTen = entries.slice(0, 10);
		for (const [addr, total] of topTen) {
			appendLine(`  ${addr} -> ${bigIntToDecimal(total)}`);
		}
		return entries[0][0];
	}

	function decodePostInteraction(callInput) {
		try {
			const decoded = ifacePostInteractionV4.decodeFunctionData('postInteraction', callInput);
			const order = decoded[0];
			let extension = decoded[1];
			if (typeof extension !== 'string') extension = ethers.hexlify(extension);
			const takerAssetAddress = toAddressFromUint(order.takerAsset);
			return { extension, takerAsset: takerAssetAddress };
		} catch (err1) {
			try {
				const decoded = ifacePostInteractionLegacy.decodeFunctionData('postInteraction', callInput);
				const order = decoded[0];
				let extension = decoded[1];
				if (typeof extension !== 'string') extension = ethers.hexlify(extension);
				return { extension, takerAsset: order.takerAsset };
			} catch (err2) {
				const reason = err2?.message || err1?.message || 'unknown decode error';
				throw new Error(`postInteraction decode failed: ${reason}`);
			}
		}
	}

	async function analyze() {
		resetOutput();

		const rpcUrl = (document.getElementById('rpcUrl')?.value || '').trim();
		const txHash = (document.getElementById('txHash')?.value || '').trim();

		if (!rpcUrl) {
			appendError('RPC URL is required');
			return;
		}
		if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
			appendError('Transaction hash is invalid');
			return;
		}

		const provider = new ethers.JsonRpcProvider(rpcUrl);
		appendLine('Fetching create tx and receipt...');

		let createTx;
		let createReceipt;
		try {
			[createTx, createReceipt] = await Promise.all([
				provider.getTransaction(txHash),
				provider.getTransactionReceipt(txHash)
			]);
		} catch (err) {
			appendError(`Failed to fetch transaction/receipt: ${err.message}`);
			return;
		}

		if (!createTx || !createReceipt) {
			appendError('Transaction or receipt not found');
			return;
		}

		appendLine(`Create tx block: ${createReceipt.blockNumber}`);

		const orderEvent = findNativeOrderCreated(createReceipt);
		if (!orderEvent) {
			appendError('NativeOrderCreated event not found in create tx receipt');
			return;
		}

		appendLine(`Maker: ${orderEvent.maker}`);
		appendLine(`OrderHash: ${orderEvent.orderHash}`);
		appendLine(`Clone: ${orderEvent.clone}`);
		appendLine(`Value: ${orderEvent.value}`);

		let expiry = 0n;
		try {
			const decodedInput = ifaceCreate.decodeFunctionData('create', createTx.data);
			const makerOrder = decodedInput[0];
			expiry = decodeMakerTraitsExpiry(makerOrder.makerTraits);
			if (expiry > 0n) {
				const date = new Date(Number(expiry) * 1000);
				appendLine(`Expiry: ${expiry} (UTC ${date.toISOString()})`);
			} else {
				appendLine('Expiry: none (makerTraits expiry == 0)');
			}
		} catch (err) {
			appendError(`MakerTraits decode failed; expiry unknown: ${err.message}`);
		}

		const fromBlock = createReceipt.blockNumber;
		const latestBlock = await provider.getBlockNumber();
		let toBlock = latestBlock;

		if (expiry > 0n) {
			try {
				const expiryBlock = await blockNumberAtOrAfterTimestamp(provider, Number(expiry));
				toBlock = Math.min(latestBlock, expiryBlock + 100000);
				appendLine(`Search window: [${fromBlock}, ${toBlock}] (expiry block ~= ${expiryBlock})`);
			} catch (err) {
				appendError(`Expiry-based window failed, using latestBlock: ${err.message}`);
				toBlock = latestBlock;
				appendLine(`Search window: [${fromBlock}, ${toBlock}]`);
			}
		} else {
			appendLine(`Search window: [${fromBlock}, ${toBlock}]`);
		}

		appendLine('Scanning for OrderFilled logs in batches...');
		const fillLogs = await batchedGetLogs(
			rpcUrl,
			ADDR_ROUTER_V6,
			TOPIC_ORDER_FILLED,
			fromBlock,
			toBlock,
			(msg) => appendError(msg)
		);

		const matchingFills = [];
		const targetHashLower = orderEvent.orderHash.toLowerCase();
		for (const log of fillLogs) {
			const dataClean = (log.data || '').slice(2);
			const candidate = '0x' + dataClean.slice(0, 64);
			if (candidate.toLowerCase() === targetHashLower) {
				matchingFills.push(log);
			}
		}

		const fillTxSet = new Set(matchingFills.map((l) => l.transactionHash));
		appendLine(`Found ${fillTxSet.size} fill tx(s) for this order`);
		for (const tx of fillTxSet) {
			appendLine(`  fill tx: ${tx}`);
		}

		for (const tx of fillTxSet) {
			appendLine(`Processing fill tx ${tx}`);
			let fillReceipt;
			try {
				fillReceipt = await provider.getTransactionReceipt(tx);
			} catch (err) {
				appendError(`Failed to fetch fill receipt: ${err.message}`);
				continue;
			}
			if (!fillReceipt) {
				appendError('Fill receipt missing');
				continue;
			}

			let orderFilledLogIndex = null;
			let orderFilledLog = null;
			for (const log of fillReceipt.logs || []) {
				if (!log.topics || log.topics.length === 0) continue;
				if (log.topics[0].toLowerCase() !== TOPIC_ORDER_FILLED.toLowerCase()) continue;
				const cand = '0x' + (log.data || '').slice(2, 66);
				if (cand.toLowerCase() === targetHashLower) {
					orderFilledLogIndex = parseLogIndex(log.logIndex);
					orderFilledLog = log;
					break;
				}
			}

			if (orderFilledLogIndex === null) {
				appendError('OrderFilled log not found in fill receipt');
				continue;
			}

			let trace;
			try {
				trace = await provider.send('debug_traceTransaction', [tx, { tracer: 'callTracer', timeout: '30s' }]);
			} catch (err) {
				appendError(`Trace not available: ${err.message}`);
			}

			let postCall = null;
			if (trace) {
				postCall = findFirstCallBySelector(trace, SELECTOR_POST_INTERACTION);
				if (!postCall) appendError('postInteraction call not found in trace');
			}

			let takerAsset;
			let extensionHex;
			if (postCall && postCall.input) {
				try {
					const decoded = decodePostInteraction(postCall.input);
					takerAsset = decoded.takerAsset;
					extensionHex = decoded.extension;
					appendLine(`takerAsset: ${takerAsset}`);
				} catch (err) {
					appendError(err.message);
				}
			} else {
				appendError('postInteraction decoding skipped; using receipt fallback only');
			}

			let likelyRecipient = null;

			if (trace && takerAsset) {
				const totals = collectErc20TransfersInSubtree(postCall, takerAsset);
				likelyRecipient = printRecipients(totals, 'Trace recipients');
			}

			if (!likelyRecipient && takerAsset) {
				const fallbackTotals = new Map();
				for (const log of fillReceipt.logs || []) {
					if (!log || !log.topics || log.topics.length < 3) continue;
					if (log.topics[0].toLowerCase() !== TOPIC_TRANSFER.toLowerCase()) continue;
					if ((log.address || '').toLowerCase() !== takerAsset.toLowerCase()) continue;
					const idx = parseLogIndex(log.logIndex);
					if (idx >= orderFilledLogIndex) continue;
					const toAddr = low20FromWord(log.topics[2]);
					const value = hexToBigInt(log.data || '0x0');
					const prev = fallbackTotals.get(toAddr) || 0n;
					fallbackTotals.set(toAddr, prev + value);
				}
				likelyRecipient = printRecipients(fallbackTotals, 'Receipt fallback recipients');
			}

			if (likelyRecipient) {
				appendLine(`Likely recipient: ${likelyRecipient}`);
			}

			// Cross-chain parsing
			if (takerAsset && takerAsset.toLowerCase() === ADDR_ERC20_TRUE.toLowerCase()) {
				appendLine('Cross-chain swap detected (ERC20True takerAsset)');
				const matchedLogs = [];
				for (const log of fillReceipt.logs || []) {
					if (!log.topics || log.topics.length === 0) continue;
					if (log.topics[0].toLowerCase() !== SIG_SRC_ESCROW_CREATED.toLowerCase()) continue;
					try {
						const decoded = decodeSrcEscrowCreated(log.data || '0x');
						if (decoded.srcImmutables.orderHash.toLowerCase() === targetHashLower) {
							matchedLogs.push({ log, decoded });
						}
					} catch (err) {
						appendError(`SrcEscrowCreated decode failed: ${err.message}`);
					}
				}

				if (matchedLogs.length === 0) {
					appendLine('No SrcEscrowCreated log found for this order in this fill tx.');
				}

				for (const { decoded } of matchedLogs) {
					const { srcImmutables: src, dstImmutablesComplement: dst, rawWords } = decoded;
					appendLine('SrcEscrowCreated parsed:');
					appendLine(`  src.orderHash: ${src.orderHash}`);
					appendLine(`  src.hashlock: ${src.hashlock}`);
					appendLine(`  src.maker: ${bigIntToDecimal(src.maker)} (as addr ${low20FromWord(rawWords[2])})`);
					appendLine(`  src.taker: ${bigIntToDecimal(src.taker)} (as addr ${low20FromWord(rawWords[3])})`);
					appendLine(`  src.token: ${bigIntToDecimal(src.token)} (as addr ${low20FromWord(rawWords[4])})`);
					appendLine(`  src.amount: ${bigIntToDecimal(src.amount)}`);
					appendLine(`  src.safetyDeposit: ${bigIntToDecimal(src.safetyDeposit)}`);
					appendLine(`  src.timelocks: ${bigIntToDecimal(src.timelocks)}`);

					appendLine(`  dst.maker: ${bigIntToDecimal(dst.maker)} (as addr ${low20FromWord(rawWords[8])})`);
					appendLine(`  dst.amount: ${bigIntToDecimal(dst.amount)}`);
					appendLine(`  dst.token: ${bigIntToDecimal(dst.token)} (as addr ${low20FromWord(rawWords[10])})`);
					appendLine(`  dst.safetyDeposit: ${bigIntToDecimal(dst.safetyDeposit)}`);
					appendLine(`  dst.chainId: ${bigIntToDecimal(dst.chainId)}`);

					if (dst.chainId === 501n) {
						if (!extensionHex) {
							appendError('Cannot reconstruct Solana pubkey: extension missing');
						} else {
							const high12 = extractHigh12FromExtension(extensionHex);
							const low20 = low20FromWord(rawWords[8]).slice(2); // drop 0x
							const solHex = reconstructSolanaPubkeyHex(high12, low20);
							const solBytes = bytesFromHex(solHex);
							const solBase58 = base58Encode(solBytes);
							appendLine('Solana maker reconstruction:');
							appendLine(`  extensionHigh12BytesHex: ${high12}`);
							appendLine(`  dstMakerLow20BytesHex: ${low20}`);
							appendLine(`  solanaPubkeyHex: ${solHex}`);
							appendLine(`  solanaPubkeyBase58: ${solBase58}`);
						}
					}
				}
			} else if (!takerAsset) {
				appendLine('Cross-chain status unknown (takerAsset not decoded)');
			}
		}
	}

	if (analyzeBtn) {
		analyzeBtn.addEventListener('click', () => {
			analyze().catch((err) => appendError(`Unexpected error: ${err.message}`));
		});
	}
})();
