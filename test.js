import { fileURLToPath } from 'url'
import { dirname } from 'path'
import fs from 'fs/promises'
import tap from 'tap-esm'
import { ethers } from 'ethers'
import toolsConfig from 'eth-tools/config.js'
import watchTx from 'eth-tools/watch-tx.js'
import compile from 'eth-tools/compile.js'
import deploy from 'eth-tools/deploy.js'
import startGeth from 'eth-tools/geth.js'

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
  geth = await startGeth(`${__dirname}/bin/geth`, { port: '7357', datadir: workDir })
  t.ok(geth)
})

tap('have provider with dev account "deployer"', async t => {
  t.plan(1)
  provider = new ethers.providers.JsonRpcProvider('http://127.0.0.1:7357')
  const providerAccounts = await provider.listAccounts()
  deployer = await provider.getSigner(providerAccounts[0])
  toolsConfig.provider = provider
  toolsConfig.ethers = ethers
  t.ok(deployer)
})

tap('compile', async t => {
  t.plan(2)
  build = await compile(`${__dirname}/bin/solc`, {
    sources: {
      'DaoToken.sol': {},
      'DaoTimelockController.sol': {},
      'DaoGovernor.sol': {},
      'node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol': {},
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
        const data = impl.interface.encodeFunctionData(impl.interface.getFunction('initialize'), [])
        t.args = [ impl.address, data ]
      },
      postDeploy: (t, all) => {
        t.contract = new ethers.Contract(t.contract.address, all.DaoToken.build.abi, deployer)
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
        t.contract = new ethers.Contract(t.contract.address, all.DaoTimelockController.build.abi, deployer)
      }
    },
    DaoGovernor: {
      build: build.contracts['DaoGovernor.sol'].DaoGovernor
    },
    DaoGovernorProxy: {
      build: build.contracts['node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol'].ERC1967Proxy,
      preDeploy: (t, all) => {
        const impl = all.DaoGovernor.contract
        const data = impl.interface.encodeFunctionData(impl.interface.getFunction('initialize'), [ all.DaoTokenProxy.contract.address, all.DaoTimelockControllerProxy.contract.address ])
        t.args = [ impl.address, data ]
      },
      postDeploy: (t, all) => {
        t.contract = new ethers.Contract(t.contract.address, all.DaoGovernor.build.abi, deployer)
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

tap('create and setup test accounts', async t => {
  const oneThousandEth = ethers.utils.parseEther('1000')
  const token = contracts.DaoTokenProxy
  const governor = contracts.DaoGovernorProxy
  const numberOfTestAccounts = 3
  t.plan(numberOfTestAccounts * 3)
  for (let i = 0; i < numberOfTestAccounts; i++) {
    // generate keys
    const account = ethers.Wallet.createRandom().connect(provider)
    accounts.push(account)
    // send 1k ether
    await watchTx(deployer.sendTransaction({ to: account.address, value: oneThousandEth }))
    const balance = await provider.getBalance(account.address)
    t.ok(balance.eq(oneThousandEth))
    // mint some voting tokens
    await watchTx(token.mint(account.address, 100))
    const tokenBalance = await token.balanceOf(account.address)
    t.equal(tokenBalance.toNumber(), 100)
    // delegate voting power
    await watchTx(token.connect(account).delegate(account.address))
    // burn one block
    await watchTx(deployer.sendTransaction({ to: account.address, value: 0 }), provider)
    // confirm voting power
    const currentBlock = await provider.getBlockNumber()
    const votingPower = await governor.getVotes(account.address, currentBlock - 1)
    t.equal(votingPower.toNumber(), 100)
  }
})

tap('setup access control', async t => {
  t.plan(1)
  const token = contracts.DaoTokenProxy
  const governor = contracts.DaoGovernorProxy
  const timelock = contracts.DaoTimelockControllerProxy
  // make the timelock the owner of the token
  await watchTx(token.transferOwnership(timelock.address))
  // make the timelock the owner of the governor
  await watchTx(governor.transferOwnership(timelock.address))
  // grant proposer and executor roles to governor
  await watchTx(timelock.grantRole(ethers.utils.id('PROPOSER_ROLE'), governor.address))
  await watchTx(timelock.grantRole(ethers.utils.id('EXECUTOR_ROLE'), governor.address))
  // remove timelock admin role from deployer
  await watchTx(timelock.revokeRole(ethers.utils.id('TIMELOCK_ADMIN_ROLE'), await deployer.getAddress()))
  t.pass()
})

tap('return correct token version', async t => {
  t.plan(1)
  t.equal(await contracts.DaoTokenProxy.version(), 'v1')
})

tap('create proposal to upgrade token', async t => {
  t.plan(1)
  const build = await compile(`${__dirname}/bin/solc`, {
    sources: {
      'DaoTokenV2.sol': {}
    }
  })
  const templates = await deploy(deployer, { 
    DaoTokenV2: {
      build: build.contracts['DaoTokenV2.sol'].DaoToken
    }
  })
  contracts.DaoTokenV2 = templates.DaoTokenV2.contract
  await watchTx(contracts.DaoGovernorProxy.propose(
    [contracts.DaoTokenProxy.address],
    [0],
    [contracts.DaoTokenProxy.interface.encodeFunctionData('upgradeTo', [ contracts.DaoTokenV2.address ])],
    'Proposal to upgrade voting token'
  ))
  t.pass()
})

tap('lookup proposal and vote on it', async t => {
  t.plan(4)
  const user0 = accounts[0]
  // const user1 = accounts[1]
  const governor = contracts.DaoGovernorProxy.connect(user0)
  // lookup proposal
  const events = await governor.queryFilter(governor.filters.ProposalCreated())
  const proposalId = events[0].args.proposalId
  // spin past voting delay
  await watchTx(deployer.sendTransaction({ to: user0.address, value: 0 }), provider)
  // cast vote
  await watchTx(governor.castVote(proposalId, 1))
  // should count 100 votes for, 0 against, 0 abstain
  const votes = await governor.proposalVotes(proposalId)
  t.equal(votes.forVotes.toNumber(), 100)
  t.equal(votes.againstVotes.toNumber(), 0)
  t.equal(votes.abstainVotes.toNumber(), 0)
  // spin until voting period is closed
  await watchTx(deployer.sendTransaction({ to: user0.address, value: 0 }), provider)
  // state should be success
  const state = await governor.state(proposalId)
  t.equal(state, 4)
})

tap('queue proposal and execute it', async t => {
  t.plan(1)
  const user0 = accounts[0]
  const governor = contracts.DaoGovernorProxy.connect(user0)
  const token = contracts.DaoTokenProxy
  const action = token.interface.encodeFunctionData('upgradeTo', [ contracts.DaoTokenV2.address ])
  const descriptionHash = ethers.utils.id('Proposal to upgrade voting token')
  // queue
  await watchTx(governor.queue(
    [token.address],
    [0],
    [action],
    descriptionHash
  ))
  // spin past timelock
  await watchTx(deployer.sendTransaction({ to: user0.address, value: 0 }), provider)
  // execute
  await watchTx(governor.execute(
    [token.address],
    [0],
    [action],
    descriptionHash
  ))
  t.pass()
})

tap('return correct token version', async t => {
  t.plan(1)
  t.equal(await contracts.DaoTokenProxy.version(), 'v2')
})

tap('kill geth', async t => {
  t.plan(1)
  geth.close()
  geth.on('exit', () => t.pass())
})
