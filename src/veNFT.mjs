import { createPublicClient, formatUnits, http } from 'viem'
import { parseAbiItem } from 'viem'
import fs from 'node:fs'
import { abi } from './abi.mjs'
import { arbitrum, canto, fantom, optimism, zkSync } from 'viem/chains'

const batch = {
  multicall: {
    wait: 16, // ms
  },
}
export const arbitrumPublicClient = createPublicClient({
  chain: arbitrum,
  transport: http(undefined, {
    // might run into rate limiting issues
    // {"code":429,"message":"Public RPC Rate Limit Hit, limit will reset in 60 seconds"}
    retryDelay: 61_000,
  }),
  batch,
})

export const cantoPublicClient = createPublicClient({
  chain: canto,
  transport: http('https://mainnode.plexnode.org:8545', {
    retryDelay: 61_000,
  }),
  batch,
})

export const fantomPublicClient = createPublicClient({
  chain: fantom,
  transport: http('https://rpc.fantom.network'),
  batch,
})

export const optimismPublicClient = createPublicClient({
  chain: optimism,
  transport: http('https://1rpc.io/op', {
    retryDelay: 61_000,
  }),
  batch,
})

export const zkSyncPublicClient = createPublicClient({
  chain: zkSync,
  transport: http(undefined, {
    retryDelay: 61_000,
  }),
  batch,
})

// different rpcs will support different chunk sizes
const chunkSize = 10000n
// rpcs won't allow searching for more than x blocks at a time
async function getMaxNFTId(publicClient, veContractAddress, toBlock) {
  if (!toBlock) {
    toBlock = await publicClient.getBlockNumber()
    console.log('blockNumber', toBlock)
  }
  try {
    const fromBlock = toBlock - chunkSize

    const logs = await publicClient.getLogs({
      address: veContractAddress,
      event: parseAbiItem(
        'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
      ),
      args: {
        from: '0x0000000000000000000000000000000000000000',
      },
      toBlock: toBlock,
      fromBlock,
    })
    if (logs.length === 0) {
      if (fromBlock === 0n) {
        return 0
      }
      return await getMaxNFTId(publicClient, veContractAddress, fromBlock)
    } else {
      return Math.max(...logs.map((log) => Number(log.args.tokenId)))
    }
  } catch (err) {
    console.log('something wrong', err)
    // // sleep 1 min
    // await new Promise((resolve) => setTimeout(resolve, 60000))
    // // retry
    // return await getMaxNFTId(publicClient, veContractAddress, toBlock)
  }
}

export async function getNFTs(publicClient, veContractAddress) {
  const t0 = performance.now()

  const maxNFTId = await getMaxNFTId(publicClient, veContractAddress)

  const t1 = performance.now()
  console.log(`getMaxNFTId took ${t1 - t0}ms`)
  console.log('maxNFTId', maxNFTId)
  // generate a multicall with all the calls you want to make
  // generate an array of maxNFTNumber length, and fill with number beginning at 1
  const nfts = [...Array(maxNFTId).keys()].map((nft) => nft + 1)

  // velodrome has huge maxNFTId > 25k, which means it will take a long time to get all the balances
  const [totalSupply, ...balances] = await publicClient.multicall({
    contracts: [
      {
        address: veContractAddress,
        abi: abi,
        functionName: 'totalSupply',
        args: [],
      },
      ...nfts.map((nft) => ({
        address: veContractAddress,
        abi: abi,
        functionName: 'balanceOfNFT',
        args: [nft],
      })),
    ],
    allowFailure: false,
  })

  const t2 = performance.now()
  console.log(`multicall balances took ${t2 - t1}ms`)

  const owners = await publicClient.multicall({
    contracts: nfts.map((nft) => ({
      address: veContractAddress,
      abi: abi,
      functionName: 'ownerOf',
      args: [nft],
    })),
    allowFailure: false,
  })

  const t3 = performance.now()
  console.log(`multicall owners took ${t3 - t2}ms`)

  const data = nfts
    .map((nft, index) => ({
      id: nft,
      balance: formatUnits(balances[index], 18),
      owner: owners[index],
    }))
    .reduce((acc, obj) => {
      acc[obj.owner] = acc[obj.owner] || []
      acc[obj.owner].push(obj)
      return acc
    }, {})
  return Object.entries(data)
    .sort((a, b) => {
      const aTotal = a[1].reduce((acc, obj) => acc + Number(obj.balance), 0)
      const bTotal = b[1].reduce((acc, obj) => acc + Number(obj.balance), 0)
      return bTotal - aTotal
    })
    .reduce((acc, [key, value]) => {
      acc.push([
        key,
        // sum all balances
        value.reduce((acc, obj) => acc + Number(obj.balance), 0),
        // influence
        value.reduce((acc, obj) => acc + Number(obj.balance), 0) /
          Number(formatUnits(totalSupply, 18)),
        value,
      ])
      return acc
    }, [])
}

export function writeMd(data, fileName, chain) {
  fs.writeFileSync(
    fileName,
    `## ${fileName.replace('.md', '')}

Total Owners: ${data.length}, Total NFTs: ${data.reduce(
      (acc, [_, __, ___, nfts]) => acc + nfts.length,
      0
    )}

| Rank | Owner | Voting Power | Influence | NFTs Id |
| --- | --- | --- | --- | --- |
  ${data
    .map(
      ([owner, balance, influence, nfts], index) =>
        `| ${
          index + 1
        } | [${owner}](https://debank.com/profile/${owner}?chain=${chain}) | ${balance.toLocaleString(
          'en-US'
        )} | ${(influence * 100).toFixed(5)}% | ${nfts
          .map((nft) => nft.id)
          .join(', ')} |`
    )
    .join('\n')}`
  )
  console.log(`File ${fileName} written`)
}
