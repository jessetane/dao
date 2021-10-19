import { fileURLToPath } from 'url'
import { dirname } from 'path'
import fs from 'fs/promises'
import tap from 'tap-esm'
import { ethers } from 'ethers'
import watchTx from './utils/watch-tx.js'
import compile from './utils/compile.js'
import deploy from './utils/deploy.js'
import startGeth from './utils/geth.js'

const __dirname = `${dirname(fileURLToPath(import.meta.url))}`
const workDir = `${__dirname}/tmp/test`

const contracts = {}
const accounts = []
var geth, provider, deployer, build;

tap('setup work dir', async t => {
  t.plan(1)
  await fs.rm(workDir, { recursive: true, force: true })
  await fs.mkdir(workDir, { recursive: true })
  t.pass()
})

tap('start geth', async t => {
  t.plan(1)
  geth = await startGeth(`${__dirname}/bin/geth`, { port: '7357', datadir: `${__dirname}/tmp/test` })
  t.ok(geth)
})

tap('have provider with dev account "deployer"', async t => {
  t.plan(1)
  provider = new ethers.providers.JsonRpcProvider('http://127.0.0.1:7357')
  let providerAccounts = await provider.listAccounts()
  deployer = await provider.getSigner(providerAccounts[0])
  t.ok(deployer)
})

tap('compile', async t => {
  t.plan(2)
  build = await compile(`${__dirname}/bin/solc`, {
    sources: {
      'DaoToken.sol': {
        urls: ['./DaoToken.sol']
      },
      'node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol': {
        urls: [`node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol`]
      }
    }
  })
  t.ok(build.contracts['DaoToken.sol'].DaoToken)
  t.ok(build.contracts['node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol'].ERC1967Proxy)
})

tap('deploy', async t => {
  const templates = await deploy(deployer, {
    DaoToken: {
      build: build.contracts['DaoToken.sol'].DaoToken
    },
    DaoTokenProxy: {
      build: build.contracts['node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol'].ERC1967Proxy,
      preDeploy: (t, all) => {
        const impl = all.DaoToken.contract
        const data = impl.interface.encodeFunctionData(impl.interface.getFunction('initialize'), all.DaoToken.initArgs || [])
        t.args = [ impl.address, data ]
      },
      postDeploy: (t, all) => {
        t.contract = new ethers.Contract(t.contract.address, all.DaoToken.build.abi, deployer)
      }
    }
  })
  t.plan(Object.keys(templates).length)
  for (let name in templates) {
    const template = templates[name]
    contracts[name] = template.contract
    t.ok(template.contract.address)
  }
})

tap('create and fund test accounts', async t => {
  const numberOfTestAccounts = 1
  t.plan(numberOfTestAccounts)
  const oneThousandEth = ethers.utils.parseEther('1000')
  for (let i = 0; i < numberOfTestAccounts; i++) {
    const account = ethers.Wallet.createRandom()
    accounts.push(account)
    await watchTx(deployer.sendTransaction({ to: account.address, value: oneThousandEth }), provider)
    const balance = await provider.getBalance(account.address)
    t.ok(balance.eq(oneThousandEth)) 
  }
})

tap('have name', async t => {
  t.plan(1)
  t.equal(await contracts.DaoTokenProxy.version(), 'v1')
})

tap('upgrade contracts', async t => {
  t.plan(1)
  const build = await compile(`${__dirname}/bin/solc`, {
    sources: {
      'DaoTokenV2.sol': {
        urls: ['DaoTokenV2.sol']
      }
    }
  })
  const templates = await deploy(deployer, { 
    DaoTokenV2: {
      build: build.contracts['DaoTokenV2.sol'].DaoToken,
      postDeploy: async t => {
        await watchTx(contracts.DaoTokenProxy.upgradeTo(t.contract.address, { gasLimit: 1000000 }))
      }
    }
  })
  t.ok(templates.DaoTokenV2.contract.address)
})

tap('have name', async t => {
  t.plan(1)
  t.equal(await contracts.DaoTokenProxy.version(), 'v2')
})

tap('kill geth', async t => {
  t.plan(1)
  geth.close()
  geth.on('exit', () => t.pass())
})
