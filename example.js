#!/usr/bin/env node

import { fileURLToPath } from 'url'
import { dirname } from 'path'
import fs from 'fs/promises'
import { ethers } from 'ethers'
import startGeth from 'eth-scripts/geth.js'
import watchTx from 'eth-scripts/watch-tx.js'
import compile from 'eth-scripts/compile.js'
import deploy from 'eth-scripts/deploy.js'

const __dirname = `${dirname(fileURLToPath(import.meta.url))}`
const workDir = `${__dirname}/tmp/example`

// persists user account and contract abis to disk
async function save () {
  await fs.writeFile(`${workDir}/env.example.json`, JSON.stringify(env, null, 2))
  for (let name in env.contracts) {
    const contract = env.contracts[name]
    await fs.writeFile(`${workDir}/abis/${contract.address}`, contract.abi)
  }
}

// generate workdir
await fs.mkdir(workDir + '/abis', { recursive: true })

// load user account
let env = null
let account = null
try {
  env = JSON.parse(await fs.readFile(`${workDir}/env.example.json`))
  console.log('loading existing account')
  if (env.account.mnemonic) {
    account = ethers.Wallet.fromMnemonic(env.account.mnemonic, `m/44'/60'/0'/0/${env.account.index || 0}`)
  } else {
    account = new ethers.Wallet(env.account.privateKey)
  }
} catch (err) {
  env = { account: {}, contracts: {} }
  console.log('creating new account')
  account = await ethers.Wallet.createRandom()
}
env.account.address = account.address
env.account.privateKey = account.privateKey
if (account.mnemonic) {
  env.account.mnemonic = account.mnemonic.phrase
}
console.log('persisting account')
await save()

// start geth
console.log('starting geth')
await startGeth(`${__dirname}/bin/geth`, { datadir: workDir, debug: true, host: '[::]', cors: 'http://localhost:8080' })
console.log('geth started')

// setup provider
const provider = new ethers.providers.JsonRpcProvider('http://127.0.0.1:8545')

// setup account
const balance = await provider.getBalance(account.address)
if (balance.eq(0)) {
  const providerAccounts = await provider.listAccounts()
  const validator = await provider.getSigner(providerAccounts[0])
  const oneThousandEth = ethers.utils.parseEther('1000')
  console.log('sending 1k ether to ' + account.address)
  await watchTx(provider, validator.sendTransaction({ to: account.address, value: oneThousandEth }))
}
account = account.connect(provider)

// render user account current balance
// balance = await provider.getBalance(account.address)
// console.log(account.address + ' balance is ' + ethers.utils.formatEther(balance) + ' ether')

// load contracts
if (!env.contracts) env.contracts = {}
const contracts = {}
for (let name in env.contracts) {
  let contract = env.contracts[name]
  if (name.indexOf('Proxy') > -1) {
    contract.proxyAbi = env.contracts[name.replace('Proxy', '')].abi
  }
  contracts[name] = new ethers.Contract(contract.address, contract.proxyAbi || contract.abi, account)
}

// build and deploy if necessary
if (!contracts.DaoToken) {
  console.log('building contracts')
  const build = await compile(`${__dirname}/bin/solc`, {
    sources: {
      'DaoToken.sol': {},
      'DaoTimelockController.sol': {},
      'DaoGovernor.sol': {},
      'node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol': {},
    }
  })
  console.log('deploying contracts')
  const templates = await deploy(ethers, account, {
    DaoToken: {
      build: build.contracts['DaoToken.sol'].DaoToken
    },
    DaoTokenProxy: {
      build: build.contracts['node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol'].ERC1967Proxy,
      preDeploy: (t, all) => {
        const impl = all.DaoToken.contract
        const data = impl.interface.encodeFunctionData(impl.interface.getFunction('initialize'), [])
        t.args = [ impl.address, data ]
      },
      postDeploy: (t, all) => {
        t.proxy = new ethers.Contract(t.address, all.DaoToken.build.abi, account)
      }
    },
    DaoTimelockController: {
      build: build.contracts['DaoTimelockController.sol'].DaoTimelockController
    },
    DaoTimelockControllerProxy: {
      build: build.contracts['node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol'].ERC1967Proxy,
      preDeploy: (t, all) => {
        const impl = all.DaoTimelockController.contract
        const data = impl.interface.encodeFunctionData(impl.interface.getFunction('initialize'), [ 1, [], [] ])
        t.args = [ impl.address, data ]
      },
      postDeploy: (t, all) => {
        t.proxy = new ethers.Contract(t.address, all.DaoTimelockController.build.abi, account)
      }
    },
    DaoGovernor: {
      build: build.contracts['DaoGovernor.sol'].DaoGovernor
    },
    DaoGovernorProxy: {
      build: build.contracts['node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol'].ERC1967Proxy,
      preDeploy: (t, all) => {
        const impl = all.DaoGovernor.contract
        const data = impl.interface.encodeFunctionData(impl.interface.getFunction('initialize'), [ all.DaoTokenProxy.contract.address, all.DaoTimelockControllerProxy.contract.address, 1, 5, 0 ])
        t.args = [ impl.address, data ]
      },
      postDeploy: (t, all) => {
        t.proxy = new ethers.Contract(t.address, all.DaoGovernor.build.abi, account)
      }
    }
  })
  console.log('persisting contract metadata')
  for (let name in templates) {
    const template = templates[name]
    contracts[name] = template.proxy || template.contract
    env.contracts[name] = {
      address: template.address,
      abi: template.contract.interface.format(ethers.utils.FormatTypes.json)
    }
  }
  await save()
}

// mint initial tokens and setup access control if necessary
const token = contracts.DaoTokenProxy
const governor = contracts.DaoGovernorProxy
const timelock = contracts.DaoTimelockControllerProxy
const tokenBalance = await token.balanceOf(account.address)
if (tokenBalance.eq(0)) {
  console.log('minting initial tokens')
  await watchTx(provider, token.mint(account.address, 100))
  console.log('delegate voting power to self')
  await watchTx(provider, token.delegate(account.address))
  console.log('make the timelock the owner of the token')
  await watchTx(provider, token.transferOwnership(timelock.address))
  console.log('make the timelock the owner of the governor')
  await watchTx(provider, governor.transferOwnership(timelock.address))
  console.log('grant proposer role to governor')
  await watchTx(provider, timelock.grantRole(ethers.utils.id('PROPOSER_ROLE'), governor.address))
  console.log('grant executor role to governor')
  await watchTx(provider, timelock.grantRole(ethers.utils.id('EXECUTOR_ROLE'), governor.address))
  console.log('remove timelock admin role from deployer')
  await watchTx(provider, timelock.revokeRole(ethers.utils.id('TIMELOCK_ADMIN_ROLE'), await account.address))
}

// go time!
console.log('ready!')
