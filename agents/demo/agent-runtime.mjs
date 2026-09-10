// agent-runtime — the autonomous Fianza demo agent.
//
// A real LLM (free Groq by default; any OpenAI-compatible provider via env)
// drives a tool-loop. The agent is a market-research agent that EARNS by
// answering questions, but a good answer needs a paid premium-data call it may
// not be able to afford right now. When it's short, it reasons and draws
// Fianza credit (working capital), buys the data, answers, and repays from
// what it earns. Every money-move is a real on-chain transaction (testnet by default; set STELLAR_NETWORK=mainnet for the live Circle USDC vault).
//
// This is spend-to-earn / working capital — NOT speculation. The agent never
// borrows to trade or gamble; it borrows to buy an input for profitable work,
// and repays from the payout. That's the whole thesis, made live.
//
// The three tools it's given map 1:1 to the SDK. Nothing here is scripted: the
// model decides whether and when to call check_credit / buy_premium_data /
// repay. We just execute and feed the real results (tx hashes) back.
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../.env") });
// The "customer" wallet that pays the agent for its research (the job payout).
dotenv.config({ path: path.resolve(here, "../.demo-holding-wallet.local") });

// Import the LOCAL built SDK by relative path (same as the analyst/scout
// servers) — NOT the npm package name. The published @fianza/agent-sdk
// on npm may lag behind local changes (e.g. the treasury auto-seed in borrow()),
// and Render installs from npm with no local symlink. The relative dist path
// guarantees the deployed agent runs exactly the SDK in this repo.
import { TrustLineAgent } from "../../packages/agent-sdk/dist/index.js";
import { runAgent } from "../shared/agent-brain.mjs";
import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  Networks,
  BASE_FEE,
} from "@stellar/stellar-sdk";

const TRUSTLINE_API = process.env.TRUSTLINE_API || "https://fianza-5m68.onrender.com";
// The paid premium-data endpoint the agent buys from (an x402 capability).
// Defaults to the analyst research server; override for the demo host.
const RESEARCH_URL = process.env.DEMO_RESEARCH_URL || "http://localhost:3022/research";
const RESEARCH_PRICE = Number(process.env.DEMO_RESEARCH_PRICE_USDC || 0.3);
// What the customer pays the agent for the finished research (the job's
// revenue). Set above the price so the job is profitable and there's cash to
// repay with. On mainnet this is a real buyer paying over x402; on testnet the
// holding wallet stands in for that customer (labeled honestly in the UI).
const JOB_PAYOUT = Number(process.env.DEMO_JOB_PAYOUT_USDC || 0.5);

// Default stays testnet so existing Render services do not flip to real USDC.
// Set STELLAR_NETWORK=mainnet (or NETWORK=mainnet) to drive the already-live
// mainnet contracts via /mainnet/* on the backend.
const NETWORK = String(process.env.STELLAR_NETWORK || process.env.NETWORK || "testnet").toLowerCase();
const IS_MAINNET = NETWORK === "mainnet" || NETWORK === "pubnet";
const EXPLORER = (h) =>
  `https://stellar.expert/explorer/${IS_MAINNET ? "public" : "testnet"}/tx/${h}`;
const NETWORK_PASSPHRASE = IS_MAINNET ? Networks.PUBLIC : Networks.TESTNET;
const USDC = new Asset(
  "USDC",
  IS_MAINNET
    ? "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
    : "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
);
const horizon = new Horizon.Server(
  IS_MAINNET ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org",
);
// The stand-in customer wallet (also our demo holding wallet).
const customer = process.env.DEMO_HOLDING_SECRET
  ? Keypair.fromSecret(process.env.DEMO_HOLDING_SECRET)
  : null;

// Testnet demo agent is the ANALYST wallet. Mainnet uses MAINNET_AGENT_SECRET
// (must match the backend key that signs /mainnet/agent/borrow|repay).
const AGENT_SECRET = IS_MAINNET
  ? process.env.MAINNET_AGENT_SECRET ||
    process.env.DEMO_AGENT_SECRET_OVERRIDE ||
    process.env.ANALYST_WALLET_SECRET
  : process.env.DEMO_AGENT_SECRET_OVERRIDE || process.env.ANALYST_WALLET_SECRET;
if (!AGENT_SECRET) {
  throw new Error(
    IS_MAINNET
      ? "MAINNET_AGENT_SECRET missing (demo mainnet agent)"
      : "ANALYST_WALLET_SECRET missing in agents/.env (demo agent)",
  );
}

const MAINNET_RPC =
  process.env.MAINNET_RPC_URL || "https://mainnet.sorobanrpc.com";
const tl = new TrustLineAgent(
  AGENT_SECRET,
  IS_MAINNET
    ? {
        apiBaseUrl: TRUSTLINE_API,
        rpcUrl: MAINNET_RPC,
        networkPassphrase: NETWORK_PASSPHRASE,
        contracts: {
          registry: "CAHWYFLMQI6BBOL6ZLZRRINCK6KVBX73ACH7LCPB24WDED4LSMCI7YZC",
          creditLine: "CDK7S4UWY227FHFKDSV37DGT7AIJ5Z2QEYO5AY456M7RBGJN25WYJVGC",
          vault: "CAE5C5UJYVED5DAVY4YKYT6E2C4NBZCIUBAK2MXGKGLKZESBBXKFPZ4U",
        },
      }
    : { apiBaseUrl: TRUSTLINE_API },
);

async function classicUsdcBalance(address) {
  const acct = await horizon.loadAccount(address);
  const row = acct.balances.find(
    (b) => b.asset_code === "USDC" && b.asset_issuer === USDC.issuer,
  );
  return row ? Number(row.balance) : 0;
}

async function mainnetCredit() {
  const r = await fetch(`${TRUSTLINE_API}/mainnet/agent/${tl.publicKey()}/credit`);
  if (!r.ok) throw new Error(`mainnet credit ${r.status}`);
  return r.json();
}

async function mainnetBorrowApi(amountUsdc) {
  const r = await fetch(`${TRUSTLINE_API}/mainnet/agent/borrow`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amountUsdc }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `mainnet borrow ${r.status}`);
  return body;
}

async function mainnetRepayApi(amountUsdc) {
  const r = await fetch(`${TRUSTLINE_API}/mainnet/agent/repay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amountUsdc }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `mainnet repay ${r.status}`);
  return body;
}

const SYSTEM = `You are Scout, an autonomous market-research agent with your own Stellar wallet and a Fianza credit line.

You earn USDC by answering research questions. To give a HIGH-QUALITY answer you must buy a premium market-data call (it costs about $${RESEARCH_PRICE} USDC). You may not always have that much cash on hand.

Follow this exact sequence, one tool at a time:
1. check_credit — see your USDC balance and your available credit line.
2. buy_premium_data(topic) — buy the data you need. If you're short on cash (you usually will be), this is working capital: the tool auto-draws the shortfall from your Fianza credit line (a real on-chain borrow). You borrow to do profitable work — never to speculate or trade. Never refuse the task for being low on cash; that's what the credit line is for.
3. Write the user a clear, useful research note grounded in what buy_premium_data returned.
4. deliver_and_get_paid — the customer pays you for the finished research (your job revenue lands as USDC).
5. repay(amountUsdc) — now that you've been paid, repay the credit you drew (plus a little for interest), out of that revenue. This is the whole point: the loan repays itself from the work it funded, and on-time repayment grows your future limit.

Narrate your reasoning briefly and plainly as you go — the user is watching you decide. Be honest about what you borrowed, earned, and repaid.`;

// ---- Tools exposed to the model ----

const tools = [
  {
    type: "function",
    function: {
      name: "check_credit",
      description:
        "Check this agent's spendable USDC balance and its live Fianza credit line (tier, limit, APR, and how much credit is still available to draw). Call this first.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "buy_premium_data",
      description:
        "Buy the premium market-data call needed to answer a research question. Costs ~$" +
        RESEARCH_PRICE +
        " USDC. If the agent is short on cash, this AUTOMATICALLY draws the shortfall from the Fianza credit line (a real on-chain borrow) and then pays. Returns the data plus any transaction hashes.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "The asset or market to research, e.g. 'XLM', 'BTC', 'AI compute demand'.",
          },
        },
        required: ["topic"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deliver_and_get_paid",
      description:
        "Deliver the finished research to the customer and collect payment (~$" +
        JOB_PAYOUT +
        " USDC) — this is the job's revenue landing in the agent's wallet as a real payment. Call this AFTER you've written the research note and BEFORE repaying.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "repay",
      description:
        "Repay the outstanding Fianza credit (interest first, then principal) out of the revenue you were just paid. On-time repayment grows the agent's future limit. Amount in USDC.",
      parameters: {
        type: "object",
        properties: {
          amountUsdc: { type: "number", description: "How much USDC to repay." },
        },
        required: ["amountUsdc"],
        additionalProperties: false,
      },
    },
  },
];

// ---- Tool implementations (real SDK / testnet) ----

async function checkCredit() {
  if (IS_MAINNET) {
    const [balance, live] = await Promise.all([
      classicUsdcBalance(tl.publicKey()),
      mainnetCredit(),
    ]);
    return {
      network: "mainnet",
      balanceUsdc: round(balance),
      availableCreditUsdc: round(live?.vault?.availableCreditUsdc ?? 0),
      tier: live?.tier ?? null,
      publishedLimitUsdc: live ? round(Number(live.limitUsdc)) : null,
      rampedLimitUsdc: null,
      aprBps: live?.aprBps ?? null,
      revenueUsdc: null,
      distinctPayers: null,
      amountOwedUsdc: live?.vault ? round(Number(live.vault.amountOwedUsdc)) : null,
    };
  }
  const [balance, live] = await Promise.all([
    tl.usdcBalanceUsdc(),
    // Live underwrite read from the backend (real numbers, not stale on-chain).
    fetch(`${TRUSTLINE_API}/agent/${tl.publicKey()}/available-credit`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  // available_credit from the vault (limit − outstanding) as the on-chain truth.
  let availableOnChain = 0;
  try {
    availableOnChain = await tl.availableCreditUsdc();
  } catch {
    /* vault may not be underwritten yet */
  }
  return {
    network: "testnet",
    balanceUsdc: round(balance),
    availableCreditUsdc: round(availableOnChain),
    tier: live?.tier ?? null,
    publishedLimitUsdc: live ? round(Number(live.limitUsdc)) : null,
    rampedLimitUsdc: live ? round(Number(live.rampedLimitUsdc)) : null,
    aprBps: live?.aprBps ?? null,
    revenueUsdc: live ? round(Number(live.revenueUsdc)) : null,
    distinctPayers: live?.distinctPayers ?? null,
  };
}

async function buyPremiumData({ topic }) {
  const balBefore = IS_MAINNET
    ? await classicUsdcBalance(tl.publicKey())
    : await tl.usdcBalanceUsdc();
  const shortfall = Math.max(0, RESEARCH_PRICE - balBefore);

  // If short, borrow the shortfall EXPLICITLY first so we capture the on-chain
  // borrow tx hash for the UI's clickable proof link (payWithCredit borrows
  // internally but only returns the paid Response, not the tx). On testnet,
  // borrow() auto-seeds the vault via the treasury. On mainnet, borrow goes
  // through /mainnet/agent/borrow against the live vault (real Circle USDC).
  let borrowTx;
  if (shortfall > 0) {
    if (IS_MAINNET) {
      const b = await mainnetBorrowApi(round(shortfall));
      borrowTx = b.txHash || b.hash;
    } else {
      const b = await tl.borrow(round(shortfall));
      borrowTx = b.txHash;
    }
  }

  // Mainnet research sellers must also settle in mainnet USDC. If the configured
  // RESEARCH_URL is still a testnet x402 host, payWithCredit will fail — keep
  // DEMO_RESEARCH_URL pointed at a mainnet-capable seller when NETWORK=mainnet.
  const res = await tl.payWithCredit(RESEARCH_URL, RESEARCH_PRICE, {
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ asset: topic }),
    },
  });
  const data = await res.json().catch(() => ({}));

  return {
    ok: res.ok,
    network: IS_MAINNET ? "mainnet" : "testnet",
    topic,
    pricePaidUsdc: RESEARCH_PRICE,
    drewCredit: shortfall > 0,
    creditDrawnUsdc: round(shortfall),
    txHash: borrowTx,
    explorerUrl: borrowTx ? EXPLORER(borrowTx) : undefined,
    research: data?.note || data?.research || JSON.stringify(data).slice(0, 600),
  };
}

async function repay({ amountUsdc }) {
  let amt = Number(amountUsdc);
  if (!(amt > 0)) {
    // Nothing to repay (the agent paid from cash and drew no credit this run).
    // Return a clean, non-error signal so the model wraps up gracefully instead
    // of treating it as a failure.
    return {
      repaid: false,
      reason: "nothing to repay — no credit was drawn this run (paid from cash).",
    };
  }
  // You can only repay with cash you actually hold. Cap the repayment at the
  // spendable balance (leaving a tiny dust buffer) so the agent never tries to
  // transfer USDC it doesn't have (which fails on-chain with a balance error).
  const bal = IS_MAINNET
    ? await classicUsdcBalance(tl.publicKey())
    : await tl.usdcBalanceUsdc();
  const spendable = Math.max(0, round(bal - 0.001));
  if (spendable <= 0) {
    return {
      repaid: false,
      reason:
        "no spare cash to repay right now — that's expected: the loan is repaid later from revenue the work earns, not immediately.",
      balanceUsdc: round(bal),
    };
  }
  if (amt > spendable) amt = spendable;
  if (IS_MAINNET) {
    const r = await mainnetRepayApi(amt);
    const txHash = r.txHash || r.hash;
    return {
      repaid: true,
      network: "mainnet",
      repaidUsdc: round(amt),
      txHash,
      explorerUrl: EXPLORER(txHash),
    };
  }
  const r = await tl.repay(amt);
  return { repaid: true, network: "testnet", repaidUsdc: round(amt), txHash: r.txHash, explorerUrl: EXPLORER(r.txHash) };
}

// Customer pays the agent for the finished research — the job's revenue.
// A REAL testnet USDC payment from the stand-in customer (holding) wallet to
// the agent. On mainnet this is a real buyer paying over x402; here the holding
// wallet plays the customer so the agent has real revenue to repay from.
async function deliverAndGetPaid() {
  if (!customer) {
    return { error: "no customer wallet configured (DEMO_HOLDING_SECRET unset)" };
  }
  const acct = await horizon.loadAccount(customer.publicKey());
  const tx = new TransactionBuilder(acct, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: tl.publicKey(),
        asset: USDC,
        amount: JOB_PAYOUT.toFixed(7),
      }),
    )
    .setTimeout(60)
    .build();
  tx.sign(customer);
  const r = await horizon.submitTransaction(tx);
  return {
    paid: true,
    revenueUsdc: round(JOB_PAYOUT),
    note: "customer paid for the research (the job's revenue)",
    txHash: r.hash,
    explorerUrl: EXPLORER(r.hash),
  };
}

const handlers = {
  check_credit: checkCredit,
  buy_premium_data: buyPremiumData,
  deliver_and_get_paid: deliverAndGetPaid,
  repay,
};

function round(n) {
  return Math.round(Number(n || 0) * 1e6) / 1e6;
}

// The amount of cash to leave the agent when you manually drain it (via the UI
// "drain" button → POST /drain). Kept low so the $0.30 data call forces a real
// credit draw on the next run — but this is operator-triggered, not automatic.
const START_CASH = Number(process.env.DEMO_START_CASH_USDC || 0.05);

/**
 * Operator action: sweep the agent's spare cash to the customer/holding wallet,
 * leaving ~START_CASH, so the next run must draw credit (the money moment).
 * Triggered manually from the UI so YOU stay in control of the demo state.
 */
export async function drainAgentCash() {
  if (!customer) return { drained: false, reason: "no customer wallet configured" };
  const bal = IS_MAINNET
    ? await classicUsdcBalance(tl.publicKey())
    : await tl.usdcBalanceUsdc();
  const excess = round(bal - START_CASH);
  if (excess <= 0.001) {
    return { drained: false, reason: "already cash-poor", balanceUsdc: round(bal) };
  }
  const acct = await horizon.loadAccount(tl.publicKey());
  const tx = new TransactionBuilder(acct, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: customer.publicKey(),
        asset: USDC,
        amount: excess.toFixed(7),
      }),
    )
    .setTimeout(60)
    .build();
  tx.sign(tl.keypair);
  const r = await horizon.submitTransaction(tx);
  return {
    drained: true,
    sweptUsdc: excess,
    balanceUsdc: START_CASH,
    txHash: r.hash,
    explorerUrl: EXPLORER(r.hash),
  };
}

/**
 * Run the agent on a user request. `onEvent` streams reasoning + tool events
 * to whatever is watching (the web UI). Returns the final answer + steps.
 */
export async function runScout(userRequest, onEvent) {
  return runAgent({
    system: SYSTEM,
    user: userRequest,
    tools,
    handlers,
    onEvent,
    maxSteps: 8,
  });
}

export const agentInfo = {
  address: tl.publicKey(),
  network: IS_MAINNET ? "mainnet" : "testnet",
  researchUrl: RESEARCH_URL,
  researchPriceUsdc: RESEARCH_PRICE,
  trustlineApi: TRUSTLINE_API,
};
