# dao
Minimal OpenZeppelin distributed autonomous organization demo.

## Why
Exercise to familiarize myself with the concepts and mechanisms.

## How
``` shell
$ npm install
$ npm run install-geth
$ npm run install-solc
$ npm run test
```

## Example
Persistent, idempotent script that provides an environment for interacting with the DAO as a human.

``` shell
$ npm run example
```

What it does:
* Spins up geth as a child process with a persistent data dir
* Deploys the DAO
* Generates an account and mints some initial voting tokens to it
* Writes account private key, contract addresses and ABIs to `env.example.json`
* Stays running so you can interact with it using dapps / wallets that allow you to talk to arbitrary networks (generally this just means they need to support custom RPC URL's)

The MetaMask wallet is the only wallet I know of that supports custom networks / RPC URL's. Currently I do not know of any general purpose dapps (or dao tooling dapps) that support custom networks.

## License
MIT
