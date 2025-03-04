const utils = require("web3-utils");
const _ = require("underscore");
const debug = require("debug")("open-tvl:web3");
const MULTICALL = require("../abis/multicall.json");
const MULTICALL_CHUNK_SIZE = 400;

async function getBalance({ web3, limiter, target }) {
  debug("getBalance", target);

  // ignore block since it requires archive nodes
  const rateLimitedGetBalance = limiter.wrap(web3.getBalance);

  const balance = await rateLimitedGetBalance(target);

  return {
    callCount: 1,
    output: balance
  };
}

async function getBalances({ web3, limiter, targets }) {
  debug("getBalances", targets);

  // ignore block since it requires archive nodes
  const rateLimitedGetBalance = limiter.wrap(web3.getBalance);

  const balances = await Promise.all(targets.map(target => rateLimitedGetBalance(target)));

  return {
    callCount: targets.length,
    output: balances
  };
}

async function getLogs({ web3, scan, limiter, target, topic, keys = [], fromBlock, toBlock }) {
  debug("getLogs", target, topic, keys, fromBlock, toBlock);

  // assume scattered events can be returned in one page
  // TODO we may need to avoid this assumption
  // and add pagination support at some point
  const txs = await scan.getTxList({ address: target, startBlock: fromBlock, endBlock: toBlock });

  debug("found txs count", txs.length);

  const blocks = txs.reduce((acc, tx) => {
    if (!acc.includes(tx.blockNumber)) {
      acc.push(tx.blockNumber);
    }

    return acc;
  }, []);

  debug("found unique block ids", blocks.length);

  const rateLimitedGetPastLogs = limiter.wrap(web3.getPastLogs);

  const allLogRequests = await Promise.all(
    blocks.map(async block => {
      const logs = await rateLimitedGetPastLogs({
        fromBlock: block,
        toBlock: block,
        address: target,
        topics: [utils.sha3(topic)]
      });

      debug("GetPastLogs for block", block);

      return logs;
    })
  );

  const allLogs = allLogRequests.reduce((acc, logs) => {
    return acc.concat(logs);
  }, []);

  debug("found log count", allLogs.length);

  if (keys && keys.length > 0) {
    debug("return with keys", keys);

    return allLogs.map(log => {
      if (keys.length === 1) {
        return log[keys[0]];
      } else {
        const filteredLog = {};
        for (const key of keys) {
          filteredLog[key] = log[key];
        }
        return filteredLog;
      }
    });
  }

  debug("return with no keys");

  return {
    callCount: allLogRequests.length,
    output: allLogs
  };
}

function normalizeCallParams(params) {
  if (!params) {
    return [];
  }

  if (Array.isArray(params)) {
    return params;
  }

  return [params];
}

async function callOne(web3, abi, target, params) {
  const contract = new web3.Contract([abi], target);
  const functionSignature = web3.abi.encodeFunctionSignature(abi);
  const method = contract.methods[functionSignature];

  // IDEALLY const result = await method(...(params || [])).call(undefined, block);
  // REALITY since only archive nodes support call with specific block number
  // and because archive nodes are expensive
  // here we just intentionally request without block
  //
  // the consequence is that we can only get accurate tvl at latest block id

  // debug("callOne", abi.name, target, params, result);
  const result = await method(...normalizeCallParams(params)).call();

  return result;
}

async function singleCall({ web3, limiter, target, abi, block, params }) {
  debug("singleCall", target, abi.name, block, params);

  const rateLimitedCallOne = limiter.wrap(callOne);

  const result = await rateLimitedCallOne(web3, abi, target, params);

  return { callCount: 1, output: result };
}

async function multiCall({ web3, multiCallProvider, limiter, target, abi, block, calls }) {
  debug("multiCall", target, abi.name, block, calls);

  if (calls.length === 0) return { callCount: 0, output: [] };

  const multiCallContract = new web3.Contract(MULTICALL, multiCallProvider);

  const rateLimitedCallChunk = limiter.wrap(async callChunk => {
    const txs = callChunk.map(call => ({
      delegateCall: false,
      revertOnError: true,
      gasLimit: 0,
      target: call.target || target,
      value: 0,
      data: web3.abi.encodeFunctionCall(abi, normalizeCallParams(call.params))
    }));

    const response = await multiCallContract.methods.multiCall(txs).call();

    return response._results.map((res, idx) => {
      const callResult = web3.abi.decodeParameters(abi.outputs, res);

      return {
        input: {
          target: callChunk[idx].target || target,
          params: normalizeCallParams(callChunk[idx].params)
        },
        success: response._successes[idx],
        // according to SDK doc, if there's only one, return result directly
        output: abi.outputs.length === 1 ? callResult[0] : callResult
      };
    });
  });

  const callChunks = _.chunk(calls, MULTICALL_CHUNK_SIZE);

  const responses = (
    await Promise.all(callChunks.map(async callChunk => await rateLimitedCallChunk(callChunk)))
  ).flat();

  // debug("Multicall Result", responses);

  return { callCount: callChunks.length, output: responses };
}

module.exports = {
  getBalance,
  getBalances,
  getLogs,
  singleCall,
  multiCall
};
