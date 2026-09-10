# Mainnet demo agent

The backend already exposes live mainnet routes and a configured agent:

- `GET /mainnet/config`
- `GET /mainnet/agent/:address/credit`
- `POST /mainnet/agent/borrow`
- `POST /mainnet/agent/repay`

Those settle **real Circle USDC** against the mainnet vault. The demo agent
runtime defaults to **testnet**. Flip it with env — do not flip the existing
testnet Render services in place.

## Enable mainnet on a dedicated agent host

Set on a **new** Render web service (or a clearly labeled staging box):

```
STELLAR_NETWORK=mainnet
TRUSTLINE_API=https://fianza-5m68.onrender.com
MAINNET_AGENT_SECRET=<same secret as backend MAINNET_AGENT_SECRET>
MAINNET_RPC_URL=<dedicated Soroban mainnet RPC — Alchemy / Ankr / QuickNode>
DEMO_HOLDING_SECRET=<mainnet-funded customer wallet>
DEMO_RESEARCH_URL=<mainnet-capable x402 research URL>
FACILITATOR_URL=https://channels.openzeppelin.com/x402
```

Start command stays `node agents/demo/agent-server.mjs`.

## Verify

```bash
curl -s "$TRUSTLINE_API/mainnet/config"
curl -s "$AGENT_HOST/info"   # should show "network":"mainnet"
```

Borrow and repay move real USDC. Deposit cap is $100 per vault. Confirm before
any public demo that spends funds.
