const { multiCall } = require("./web3");
const { decimalify } = require("../util");

async function toSymbols(addresses) {
  // remove zero address which serves as a address for ETH/BNB
  const queryAddresses = Object.keys(addresses).filter((t) => t !== "0x0000000000000000000000000000000000000000");
  // use multicall to request symbols of the tokens
  const symbols = (
    await multiCall({
      abi: "bep20:symbol",
      calls: queryAddresses.map((t) => {
        return { target: t };
      }),
    })
  ).reduce(
    (m, t) => {
      m[t.input.target] = t.output;
      return m;
    },
    { "0x0000000000000000000000000000000000000000": "BNB" }
  );
  // use multicall to request decimals of the tokens
  const decimals = (
    await multiCall(
      "bep20:decimals",
      queryAddresses.map((t) => {
        return { target: t };
      })
    )
  ).reduce(
    (m, t) => {
      m[t.input.target] = t.output;
      return m;
    },
    { "0x0000000000000000000000000000000000000000": 18 }
  );
  // aggregate the symbols and decimals
  const result = Object.keys(addresses).reduce((m, t) => {
    m[symbols[t]] = decimalify(addresses[t], decimals[t]);
    return m;
  }, {});
  return result;
}

module.exports = { toSymbols };
