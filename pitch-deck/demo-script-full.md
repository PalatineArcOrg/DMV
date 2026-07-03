# Dead Man's Vault — Full Demo Script (3-4 min)

## Target
Hackathon submission video, detailed showcase, investor demo.

## Pre-Recording Setup
1. Install v1.5.9 on Seeker
2. Airdrop ~3 SOL to Fox wallet on devnet
3. Enable demo mode (Settings > 5-tap version text) — stages run in 30s each
4. Do NOT have a vault active — we'll create one live
5. Have 2 beneficiary wallet addresses ready (can use any devnet addresses)
6. Optional: send a test SPL token to the vault after setup for token distribution demo

---

### ACT 1: THE PROBLEM (0:00 - 0:25)

**[Show: Phone lock screen, then open app to Dashboard — no vault active]**

> "Right now, over $140 billion in crypto sits in wallets that nobody can access. The owners are gone, and there's no way to recover the assets. Traditional inheritance doesn't work for self-custodied wallets — there's no bank to call, no legal framework that understands private keys."

> "Dead Man's Vault solves this. It's an autonomous crypto inheritance protocol built natively for Solana Seeker. No backend servers, no cloud functions, no trusted third parties. Everything runs on your device or on the Solana blockchain."

---

### ACT 2: VAULT SETUP (0:25 - 1:15)

**[Show: Tap Vault tab > Start Setup]**

> "Let's set up a vault from scratch. First, we add beneficiaries — the wallets that will receive our assets if we stop responding."

**[Show: Add 2 beneficiaries — paste addresses, set labels like "Alice" / "Bob", set shares 60/40]**

> "Each beneficiary gets a label and a percentage share. These are stored on-chain — the program enforces that shares add up to exactly 100%, and it will only ever send assets to these pre-approved wallets."

**[Show: Heartbeat config — select interval]**

> "Next, the heartbeat interval. This is how often you need to confirm you're still around. Weekly, bi-weekly, or monthly. For this demo, we'll use demo mode which runs the full cycle in about two minutes."

**[Show: EstateReview screen — on-chain details with cost breakdown]**

> "Here's the full review. You can see the on-chain cost breakdown — about 0.015 SOL for vault rent, plus 0.05 SOL to fund the agent key. The agent key lives in the device's hardware secure enclave and handles heartbeats and execution autonomously — your owner wallet is never exposed."

**[Tap Activate > Approve in Seed Vault]**

> "One transaction through Seed Vault creates the vault, funds the agent, and records the first heartbeat. We're live."

---

### ACT 3: DASHBOARD + PORTFOLIO (1:15 - 1:45)

**[Show: Dashboard — Stage 0 green, heartbeat status, vault balance]**

> "The dashboard shows everything at a glance — current escalation stage, vault balance, time until next heartbeat, and your full portfolio."

**[Show: Assets tab — token balances with USD prices]**

> "The Assets tab pulls live token balances via Helius DAS API and USD prices from Pyth and Jupiter oracles. It detects DeFi positions across major protocols too."

**[Show: Vault balance card on Dashboard]**

> "Your vault PDA holds the deposited SOL and any SPL tokens. You can deposit or withdraw anytime — it's your money until Stage 4."

---

### ACT 4: ESCALATION (1:45 - 2:30)

**[Show: Dashboard — wait for heartbeat to go overdue in demo mode]**

> "Now let's see what happens when I stop responding. In demo mode, each stage lasts 30 seconds instead of days."

**[Show: Stage 1 — yellow, notification appears]**

> "Stage 1 — Reminder. The app sends a push notification: 'Your vault heartbeat is overdue.' I can tap the heartbeat button anytime to reset back to Stage 0."

**[Show: Stage 2 — orange, more urgent notification]**

> "Stage 2 — Alert. Notifications get more frequent. It tells me how many beneficiaries are affected and how long I've been overdue."

**[Show: Stage 3 — red, FINAL WARNING notification]**

> "Stage 3 — Final Warning. Hourly alerts in production. The notification shows exactly how much time is left before execution. This is the last chance."

> "These notifications fire even if the app is killed — they're scheduled through the OS, not just in-app."

**[Show: Stage 4 transition — execution started notification]**

> "Stage 4. Irreversible. The agent takes over."

---

### ACT 5: AUTONOMOUS EXECUTION (2:30 - 3:15)

**[Show: Execution happening — progress notifications]**

> "The agent is now autonomously distributing assets. Watch the notifications — it sends progress updates for each step."

**[Show: Execution logs screen with completed steps]**

> "Every step is visible in the execution log. Distribute SOL to Alice — transaction signature. Distribute SOL to Bob — transaction signature. Each one is a real on-chain transaction you can verify on Solana Explorer."

**[Tap a transaction to open in Explorer if possible]**

> "Record execution on-chain — this creates an immutable log. Close vault PDAs — rent goes back to the owner. Refund agent SOL — the agent sends its remaining SOL back to your wallet. And finally, destroy agent key."

> "If the app crashes at any point during this, it resumes from the last checkpoint. Every step is saved to SQLite before executing. This is crash-proof by design."

---

### ACT 6: ARCHITECTURE + CLOSE (3:15 - 3:45)

**[Show: Settings screen — program ID, version, notification status]**

> "Under the hood: 13 on-chain instructions in the Anchor program with 34 passing tests and 19 error codes. The program only enforces who can transfer, where, and when. All complex logic lives in the mobile app."

> "The owner can always override — withdraw assets, rotate the agent key on a new device, or revoke the vault entirely. Owner supremacy is a core design principle."

**[Show: Website or title slide]**

> "Dead Man's Vault. An autonomous crypto inheritance protocol for Solana Seeker. No backend, no intermediaries — just you, your device, and the blockchain."

> "Your crypto should outlive you. Download the APK at dmv.palatinearc.com."

---

## Recording Tips

- **Demo mode**: Enable via Settings > 5-tap on version text. Stages run in 30s. Full cycle takes ~2 minutes.
- **Screen recording**: Use Seeker's built-in screen recorder or scrcpy from desktop.
- **Notifications**: Make sure notification permissions are granted. Verify with Settings screen (shows Enabled/Disabled).
- **Voiceover**: Record narration separately and overlay — cleaner audio than recording with phone mic.
- **Pacing**: Don't rush the setup wizard — viewers need to see each screen. Speed up the escalation wait with a video cut if needed.
- **Fallback**: If demo mode timing is awkward, record setup and execution separately and splice together.
- **Token distribution**: If you want to show SPL token distribution, send a test token to the vault PDA before the demo run. The execution plan will include distribute_token steps alongside distribute_sol.
