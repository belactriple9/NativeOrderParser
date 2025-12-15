/*
 * 1inch Native Order Analyzer (ethers v6)
 *
 * Key fixes vs the previous version:
 * - Correctly decodes NativeOrderCreated which is *not indexed* (topic0 only)
 * - Uses ethers v6 APIs
 * - Uses the correct IOrderMixin.Order ABI shape used by SimpleSettlement
 */

(() => {
  // ---- DOM ----
  const rpcInput = document.getElementById('rpcUrl');
  const txInput = document.getElementById('txHash');
  const btn = document.getElementById('analyzeButton');
  const output = document.getElementById('output');

  // Basic sanity check: this build expects ethers v6 (global `ethers` has JsonRpcProvider + id()).
  if (!window.ethers || typeof ethers.JsonRpcProvider !== 'function' || typeof ethers.id !== 'function') {
    const div = document.createElement('div');
    div.classList.add('error');
    div.textContent = 'This app.js requires ethers v6. Update index.html to load ethers@6.x (ethers.umd.min.js).';
    output.appendChild(div);
    return;
  }

  // ---- Constants ----
  const SIG_NATIVE_ORDER_CREATED = ethers
    .id('NativeOrderCreated(address,bytes32,address,uint256)')
    .toLowerCase();

  const AGGREGATION_ROUTER_v6 = "0x111111125421cA6dc452d289314280a0f8842A65"; // required to filter the orderFilled event

  // Limit Order Protocol commonly uses this event signature:
  const SIG_ORDER_FILLED = ethers
    .id('OrderFilled(bytes32,uint256)') // bytes32 orderHash, uint256 remainingAmount; topic 0xfec331350fce78ba658e082a71da20ac9f8d798a99b3c79681c8440cbfe77e07
    .toLowerCase();

  const SIG_ERC20_TRANSFER = ethers
    .id('Transfer(address,address,uint256)')
    .toLowerCase();

  // postInteraction() selector for SimpleSettlement shown on Codeslaw.
  // (We match on selector rather than contract address since fills can involve multiple hops.)
  const POST_INTERACTION_SELECTOR = '0x462ebde2';

  const ADDRESS_MASK_160 = (1n << 160n) - 1n;

  // ---- ABI fragments ----
  // NativeOrderCreated has NO indexed parameters (topic0 only).
  // Source: NativeOrderFactory contract code (see citations in chat).
  const ifaceNativeOrderCreated = new ethers.Interface([
    'event NativeOrderCreated(address maker, bytes32 orderHash, address clone, uint256 value)',
  ]);

  // Some deployments *may* have indexed variants; keep a fallback.
  const ifaceNativeOrderCreatedIndexedFallback = new ethers.Interface([
    'event NativeOrderCreated(address indexed maker, bytes32 indexed orderHash, address clone, uint256 value)',
  ]);

  // NativeOrderFactory.create(IOrderMixin.Order)
  // IOrderMixin.Order ABI shape (used by SimpleSettlement / Limit Order Protocol):
  // struct Order { uint256 salt; Address maker; Address receiver; Address makerAsset; Address takerAsset;
  //                uint256 makingAmount; uint256 takingAmount; MakerTraits makerTraits; }
  // NOTE: Address and MakerTraits are value-types that ABI-encode as uint256.
  const ifaceNativeFactoryCreate = new ethers.Interface([
    'function create((uint256 salt,uint256 maker,uint256 receiver,uint256 makerAsset,uint256 takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 makerTraits) makerOrder) payable returns (address clone)',
  ]);

  // SimpleSettlement.postInteraction(Order, bytes, bytes32, address, uint256, uint256, uint256, bytes)
  const ifacePostInteraction = new ethers.Interface([
    'function postInteraction((uint256 salt,uint256 maker,uint256 receiver,uint256 makerAsset,uint256 takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 makerTraits) order,bytes extension,bytes32 orderHash,address taker,uint256 makingAmount,uint256 takingAmount,uint256 remainingMakingAmount,bytes extraData)',
  ]);

  // Older “legacy” Order shapes exist; keep a decode fallback.
  const ifacePostInteractionLegacy = new ethers.Interface([
    'function postInteraction((uint256 salt,address maker,address receiver,address makerAsset,address takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 offsets,bytes interactions) order,bytes extension,bytes32 orderHash,address taker,uint256 makingAmount,uint256 takingAmount,uint256 remainingMakingAmount,bytes extraData)',
  ]);

  // ---- UI helpers ----
  function clearOutput() {
    output.innerHTML = '';
  }

  function log(line, isError = false) {
    const div = document.createElement('div');
    if (isError) div.classList.add('error');
    div.textContent = line;
    output.appendChild(div);
  }

  function isTxHash(x) {
    return /^0x([A-Fa-f0-9]{64})$/.test(x);
  }

  function topicToAddress(topic) {
    // topic is 32 bytes; address is right-aligned
    return ethers.getAddress('0x' + topic.slice(26));
  }

  function u256ToAddress(u) {
    // 1inch Address value-type stores address in low 160 bits
    const addrHex = '0x' + (u & ADDRESS_MASK_160).toString(16).padStart(40, '0');
    return ethers.getAddress(addrHex);
  }

  function wordToAddress(wordHex) {
    // wordHex: 64 hex chars
    return ethers.getAddress('0x' + wordHex.slice(24));
  }

  function decodeErc20Transfer(input) {
    const data = (input || '').toLowerCase();
    if (!data.startsWith('0xa9059cbb') || data.length < 10 + 64 * 2) return null;
    const body = data.slice(10);
    const to = wordToAddress(body.slice(0, 64));
    const amount = BigInt('0x' + body.slice(64, 128));
    return { to, amount };
  }

  function decodeErc20TransferFrom(input) {
    const data = (input || '').toLowerCase();
    if (!data.startsWith('0x23b872dd') || data.length < 10 + 64 * 3) return null;
    const body = data.slice(10);
    const to = wordToAddress(body.slice(64, 128));
    const amount = BigInt('0x' + body.slice(128, 192));
    return { to, amount };
  }

  function collectTakerTransfersFromTrace(call, takerAssetLower, acc) {
    if (!call) return;
    const toAddr = (call.to || '').toLowerCase();
    if (toAddr === takerAssetLower && typeof call.input === 'string') {
      let decoded = decodeErc20Transfer(call.input);
      if (!decoded) decoded = decodeErc20TransferFrom(call.input);
      if (decoded) acc.push(decoded);
    }
    if (Array.isArray(call.calls)) {
      for (const c of call.calls) collectTakerTransfersFromTrace(c, takerAssetLower, acc);
    }
  }

  function uniq(arr) {
    return [...new Set(arr)];
  }

  // ---- Trace traversal ----
  function findCallBySelector(call, selector) {
    if (!call) return null;
    const input = (call.input || '').toLowerCase();
    if (typeof input === 'string' && input.startsWith(selector)) return call;
    if (Array.isArray(call.calls)) {
      for (const c of call.calls) {
        const hit = findCallBySelector(c, selector);
        if (hit) return hit;
      }
    }
    return null;
  }

  async function blockNumberAtOrAfterTimestamp(provider, startBlock, endBlock, targetTs) {
    // Optimization: if targetTs is in the past or present, just return endBlock
    const latestBlock = await provider.getBlock(endBlock);
    if (!latestBlock) throw new Error(`Failed to fetch block ${endBlock}`);
    if (latestBlock.timestamp < targetTs) {
      // Target is in the future, binary search
      let lo = startBlock;
      let hi = endBlock;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const b = await provider.getBlock(mid);
        if (!b) throw new Error(`Failed to fetch block ${mid}`);
        if (b.timestamp >= targetTs) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    } else {
      // Target is in the past or present, just use endBlock
      return endBlock;
    }
  }

  function decodeNativeOrderCreatedLog(logEntry) {
    // First try the correct no-index event, then fallback.
    try {
      return ifaceNativeOrderCreated.parseLog(logEntry);
    } catch (e) {
      return ifaceNativeOrderCreatedIndexedFallback.parseLog(logEntry);
    }
  }

  async function analyze() {
    clearOutput();

    const rpcUrl = (rpcInput.value || '').trim();
    const txHash = (txInput.value || '').trim();

    if (!rpcUrl) {
      log('Please provide an RPC URL.', true);
      return;
    }
    if (!isTxHash(txHash)) {
      log('Please provide a valid transaction hash.', true);
      return;
    }

    log(`Using ethers ${ethers.version}…`);
    log(`Connecting to RPC at ${rpcUrl}…`);

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    let receipt;
    let tx;
    try {
      [receipt, tx] = await Promise.all([
        provider.getTransactionReceipt(txHash),
        provider.getTransaction(txHash),
      ]);
    } catch (e) {
      log(`RPC error fetching tx/receipt: ${e?.message || String(e)}`, true);
      return;
    }

    if (!receipt) {
      log('No receipt returned. Is the transaction hash correct and indexed by your RPC?', true);
      return;
    }
    log(`Transaction mined in block ${receipt.blockNumber}.`);

    // ---- Find NativeOrderCreated ----
    let nativeCreated = null;
    for (const lg of receipt.logs) {
      const t0 = (lg.topics?.[0] || '').toLowerCase();
      if (t0 === SIG_NATIVE_ORDER_CREATED) {
        try {
          nativeCreated = decodeNativeOrderCreatedLog(lg);
          break;
        } catch (e) {
          // If topic0 matches but parse fails, show debug so we can see exactly why.
          log(
            `Found topic0 match but failed to parse NativeOrderCreated: topics=${lg.topics.length}, dataLen=${(lg.data || '').length}`,
            true,
          );
        }
      }
    }

    if (!nativeCreated) {
      log('No NativeOrderCreated parsed from receipt.logs.', true);
      log('Debug: topic0 list from receipt logs (topic0 | topicsLen | address):');
      for (const lg of receipt.logs) {
        log(`${lg.topics?.[0]} | ${lg.topics?.length ?? 0} | ${lg.address}`);
      }
      return;
    }

    const maker = nativeCreated.args.maker;
    const orderHashFromFactory = nativeCreated.args.orderHash;
    const clone = nativeCreated.args.clone;
    const valueWei = nativeCreated.args.value;

    log('NativeOrderCreated parsed ✅');
    log(`  maker: ${maker}`);
    log(`  orderHash (factory): ${orderHashFromFactory}`);
    log(`  clone: ${clone}`);
    log(`  value: ${valueWei.toString()} wei`);

    // ---- Decode create() calldata to get makerTraits (for expiration) ----
    let expiryTs = null;
    try {
      if (tx?.data && tx.data !== '0x') {
        const decoded = ifaceNativeFactoryCreate.decodeFunctionData('create', tx.data);
        const makerOrder = decoded.makerOrder;
        const makerTraits = BigInt(makerOrder.makerTraits);
        const exp = (makerTraits >> 80n) & ((1n << 40n) - 1n);
        if (exp !== 0n) {
          expiryTs = Number(exp);
          log(`Decoded makerTraits.expiry = ${expiryTs} (unix seconds)`);
        } else {
          log('Decoded makerTraits.expiry = 0 (no explicit expiry)');
        }
      }
    } catch (e) {
      log(`Could not decode create() calldata for expiry: ${e?.message || String(e)}`);
    }

    // ---- Determine log search window ----
    let latestBlock;
    try {
      latestBlock = await provider.getBlockNumber();
    } catch (e) {
      log(`Failed to fetch latest block: ${e?.message || String(e)}`, true);
      return;
    }

    let toBlock = latestBlock;
    if (expiryTs != null) {
      try {
        // Add a small buffer (1 hour) to be safe.
        const target = expiryTs + 3600;
        toBlock = await blockNumberAtOrAfterTimestamp(provider, receipt.blockNumber, latestBlock, target);
        log(`Searching fills from block ${receipt.blockNumber} to ${toBlock} (bounded by expiry).`);
      } catch (e) {
        log(`Expiry-based bounding failed; falling back to latest: ${e?.message || String(e)}`);
        toBlock = latestBlock;
      }
    } else {
      log(`Searching fills from block ${receipt.blockNumber} to latest (${latestBlock}).`);
    }


    // ---- Find fill logs for AGGREGATION_ROUTER_v6, then filter by orderHash in data ----
    let fillLogs = [];
    const batchSize = 25; // max requests per batch
    let batchRequests = [];
    let blockRanges = [];
    // Split block range into batches of up to 25 blocks each
    for (let start = receipt.blockNumber; start <= toBlock; start += batchSize) {
      const end = Math.min(start + batchSize - 1, toBlock);
      blockRanges.push({ fromBlock: start, toBlock: end });
    }

    // Prepare batch requests
    for (let i = 0; i < blockRanges.length; i += batchSize) {
      const batch = blockRanges.slice(i, i + batchSize);
      batchRequests.push(batch);
    }

    // For each batch of up to 25 block ranges, send a batch JSON-RPC request
    for (const batch of batchRequests) {
      const rpcBatch = batch.map((range, idx) => ({
        jsonrpc: "2.0",
        id: idx + 1,
        method: "eth_getLogs",
        params: [{
          fromBlock: ethers.toBeHex(range.fromBlock),
          toBlock: ethers.toBeHex(range.toBlock),
          address: AGGREGATION_ROUTER_v6,
          topics: [SIG_ORDER_FILLED],
        }],
      }));
      try {
        // Use fetch to send the batch request directly to the RPC URL
        const res = await fetch(rpcInput.value, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rpcBatch),
        });
        const json = await res.json();
        for (const result of json) {
          if (result && result.result && Array.isArray(result.result)) {
            fillLogs.push(...result.result);
          }
        }
      } catch (e) {
        log(`eth_getLogs batch failed: ${e?.message || String(e)}`, true);
        // Continue with what we have
      }
    }

    // Now filter logs by orderHash in data (first 32 bytes)
    const orderHashHex = orderHashFromFactory.toLowerCase();
    const filteredLogs = fillLogs.filter(lg => {
      if (!lg.data || lg.data.length < 66) return false; // 0x + 64 hex chars
      // data: 0x + 64 (orderHash) + 64 (remainingAmount)
      const logOrderHash = '0x' + lg.data.slice(2, 66).toLowerCase();
      return logOrderHash === orderHashHex;
    });

    if (filteredLogs.length === 0) {
      log('No OrderFilled logs found for this orderHash in the search window.', true);
      return;
    }

    const fillLogsByTx = new Map();
    for (const lg of filteredLogs) {
      if (!fillLogsByTx.has(lg.transactionHash)) fillLogsByTx.set(lg.transactionHash, []);
      fillLogsByTx.get(lg.transactionHash).push(lg);
    }

    const fillTxHashes = [...fillLogsByTx.keys()];
    log(`Found ${filteredLogs.length} OrderFilled logs across ${fillTxHashes.length} tx(s).`);

    // ---- For each fill tx: trace + decode postInteraction + derive recipients ----
    for (const fillTxHash of fillTxHashes) {
      log('');
      log(`Fill tx: ${fillTxHash}`);

      const fillReceipt = await provider.getTransactionReceipt(fillTxHash);
      if (!fillReceipt) {
        log('  Missing receipt for fill tx (RPC indexing issue?)', true);
        continue;
      }

      let trace;
      try {
        trace = await provider.send('debug_traceTransaction', [
          fillTxHash,
          { tracer: 'callTracer', timeout: '30s' },
        ]);
      } catch (e) {
        log(`  debug_traceTransaction failed: ${e?.message || String(e)}`, true);
        continue;
      }

      const postCall = findCallBySelector(trace, POST_INTERACTION_SELECTOR);
      if (!postCall) {
        log('  postInteraction call not found in trace (selector 0x462ebde2).', true);
        continue;
      }

      let decodedPost;
      try {
        decodedPost = ifacePostInteraction.decodeFunctionData('postInteraction', postCall.input);
      } catch (e1) {
        try {
          decodedPost = ifacePostInteractionLegacy.decodeFunctionData('postInteraction', postCall.input);
        } catch (e2) {
          log(`  postInteraction decode failed (both ABIs).`, true);
          log(`    v4 decode error: ${e1?.message || String(e1)}`, true);
          log(`    legacy decode error: ${e2?.message || String(e2)}`, true);
          continue;
        }
      }

      const filledOrderHash = decodedPost.orderHash;
      const order = decodedPost.order;

      // Extract takerAsset from the decoded Order.
      // If we decoded the v4 shape, fields are uint256.
      let takerAsset;
      try {
        if (typeof order.takerAsset !== 'undefined') {
          // v4 shape
          takerAsset = u256ToAddress(BigInt(order.takerAsset));
        } else {
          // legacy shape is address
          takerAsset = ethers.getAddress(order[4]);
        }
      } catch (e) {
        log(`  Failed to extract takerAsset: ${e?.message || String(e)}`, true);
        continue;
      }

      log(`  postInteraction.orderHash: ${filledOrderHash}`);
      log(`  takerAsset: ${takerAsset}`);

      // ---- Collect transfers from trace subtree under postInteraction to takerAsset ----
      const takerAssetLower = takerAsset.toLowerCase();
      const traceTransfers = [];
      collectTakerTransfersFromTrace(postCall, takerAssetLower, traceTransfers);

      let transfers = traceTransfers;
      if (transfers.length === 0) {
        // Fallback to receipt logs (pre-OrderFilled) only if trace had none
        const orderFilledLog = (fillLogsByTx.get(fillTxHash) || [])[0];
        const orderFilledLogIndex = orderFilledLog?.logIndex;
        for (const lg of fillReceipt.logs) {
          if (orderFilledLogIndex != null && lg.logIndex >= orderFilledLogIndex) continue;
          if (lg.address.toLowerCase() !== takerAssetLower) continue;
          const t0 = (lg.topics?.[0] || '').toLowerCase();
          if (t0 !== SIG_ERC20_TRANSFER) continue;
          if (!lg.topics || lg.topics.length < 3) continue;

          const to = topicToAddress(lg.topics[2]);
          const amount = BigInt(lg.data);
          transfers.push({ to, amount });
        }
      }

      if (transfers.length === 0) {
        log('  No takerAsset transfers found within postInteraction scope.', true);
        continue;
      }

      // Aggregate received amounts by recipient
      const byRecipient = new Map();
      for (const t of transfers) {
        const prev = byRecipient.get(t.to) || 0n;
        byRecipient.set(t.to, prev + t.amount);
      }

      const ranked = [...byRecipient.entries()]
        .map(([to, amount]) => ({ to, amount }))
        .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));

      log('  takerAsset recipients (aggregated, postInteraction-scoped):');
      for (const r of ranked.slice(0, 10)) {
        log(`    ${r.to}  <=  ${r.amount.toString()}`);
      }

      const likelyRecipient = ranked[0];
      if (likelyRecipient) {
        log(`  Likely final recipient (largest transfer in postInteraction): ${likelyRecipient.to}`);
      }
    }
  }

  btn.addEventListener('click', () => {
    analyze().catch((e) => log(`Unexpected error: ${e?.message || String(e)}`, true));
  });
})();
