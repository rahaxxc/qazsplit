"use client";

import { address, type Address, type Instruction } from "@solana/kit";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import { useClient } from "@solana/react";
import { Check, ExternalLink, Link2, LoaderCircle, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";

import {
  buildCreateSplitInstruction,
  simulateInstructions,
} from "@/lib/qazsplit-client";
import { MOCK_USDC_MINT } from "@/lib/constants";
import { buildProposeSplitInstruction, validateMilestones } from "@/lib/agreement-client";
import type { AppClient } from "@/lib/solana-client";
import { getTransactionClient, getWalletTransactionVersion, type WalletTransactionVersion } from "@/lib/transaction-compat";
import { parsePercentToBps, parseTokenAmount } from "@/lib/split-math";

type Row = { id: number; wallet: string; percent: string };
type Prepared = { instruction: Instruction; splitConfig: Address; splitId: bigint; creator: Address; transactionVersion: WalletTransactionVersion };

const initialRows: Row[] = [
  { id: 1, wallet: "", percent: "50" },
  { id: 2, wallet: "", percent: "30" },
  { id: 3, wallet: "", percent: "20" },
];

const subscribeToHydration = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

function messageFromError(error: unknown): string {
  // The SDK wraps wallet errors; the original rejection lives in Error.cause.
  for (let depth = 0; depth < 5 && error instanceof Error && error.cause instanceof Error; depth++) {
    error = error.cause;
  }
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

export function CreateSplitForm({ withMilestones = false }: { withMilestones?: boolean }) {
  const client = useClient<AppClient>();
  const wallet = useConnectedWallet(client);
  const hydrated = useSyncExternalStore(subscribeToHydration, getClientSnapshot, getServerSnapshot);
  // Auto-reconnect may finish before hydration; start with the same server reason.
  const connected = hydrated ? wallet : null;
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [phase, setPhase] = useState<"idle" | "simulating" | "ready" | "signing" | "success">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [nextId, setNextId] = useState(4);
  const [milestones, setMilestones] = useState([{ id: 1, name: "Design", amount: "10" }]);
  const [nextMilestoneId, setNextMilestoneId] = useState(2);
  const parsedMilestones = milestones.map((m) => ({ name: m.name.trim(), amount: parseTokenAmount(m.amount) ?? 0n }));
  let milestoneReason: string | null = null;
  if (withMilestones) {
    try { validateMilestones(parsedMilestones); }
    catch (error) { milestoneReason = messageFromError(error); }
  }

  const parsedShares = useMemo(
    () => rows.map((row) => parsePercentToBps(row.percent)),
    [rows],
  );
  const totalBps = parsedShares.reduce<number>(
    (sum, share) => sum + (share ?? 0),
    0,
  );
  const recipients = useMemo(() => {
    try {
      return rows.map((row) => address(row.wallet.trim()));
    } catch {
      return null;
    }
  }, [rows]);
  const transactionVersion = connected ? getWalletTransactionVersion(connected.supportedTransactionVersions) : null;
  const validationReason = !connected?.signer
    ? "Connect your wallet first"
    : rows.length < 2 || rows.length > 5 || !recipients
      ? "Enter valid recipient addresses"
      : new Set(recipients).size !== recipients.length
        ? "Recipient addresses must be unique"
        : totalBps !== 10_000
          ? "Allocation must total 100%"
          : parsedShares.some((share) => share == null || share <= 0)
            ? "Enter valid positive share percentages"
            : transactionVersion == null
              ? "This wallet cannot sign supported Solana transactions. Try Phantom or Solflare."
              : milestoneReason;
  const busy = phase === "simulating" || phase === "signing";
  const preparedForWallet = prepared?.creator === connected?.account.address
    && prepared?.transactionVersion === transactionVersion;
  const canCreate = !validationReason && !busy && !!prepared && preparedForWallet;
  const createReason = validationReason ?? (busy
    ? phase === "simulating" ? "Wait for simulation to finish" : "Approve or cancel the request in your wallet"
    : !prepared || !preparedForWallet ? "Simulate config first" : null);

  function updateRow(id: number, patch: Partial<Row>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    setPrepared(null);
    setPhase("idle");
    setError(null);
  }

  async function handleSimulate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSignature(null);
    if (validationReason || !connected?.signer || !recipients || transactionVersion == null || busy) {
      setError(validationReason ?? "Wait for the current request to finish.");
      return;
    }

    setPrepared(null);
    setPhase("simulating");
    try {
      const creator = address(connected.account.address);
      const splitId = BigInt(Date.now());
      const input = {
        creator,
        mint: MOCK_USDC_MINT,
        splitId,
        recipients,
        sharesBps: parsedShares as number[],
      };
      const built = withMilestones
        ? await buildProposeSplitInstruction({ ...input, milestones: parsedMilestones })
        : await buildCreateSplitInstruction(input);
      await simulateInstructions(client, creator, [built.instruction], transactionVersion);
      setPrepared({ ...built, splitId, creator, transactionVersion });
      setPhase("ready");
    } catch (simulationError) {
      setPhase("idle");
      setError(messageFromError(simulationError));
    }
  }

  async function handleCreate() {
    if (!canCreate || !prepared || !connected?.signer) {
      setError(createReason ?? "Simulate config first");
      return;
    }
    setPhase("signing");
    setError(null);
    try {
      const result = await getTransactionClient(client, prepared.transactionVersion).sendTransaction([prepared.instruction]);
      setSignature(result.context.signature);
      setPhase("success");
    } catch (sendError) {
      setPhase("ready");
      const message = messageFromError(sendError);
      setError(/reject|declin|cancel/i.test(message) ? "Signature request was cancelled." : message);
    }
  }

  return (
    <form className="form-panel" onSubmit={handleSimulate} noValidate>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">1 · Create Split</p>
          <h1>{withMilestones ? "Agree on the team allocation" : "Lock the team allocation"}</h1>
          <p>
            {withMilestones
              ? "Propose 2–5 wallets and fixed milestones. Terms cannot change; every recipient must approve their share before payments unlock."
              : "Add 2–5 wallets. The percentages become immutable when your wallet creates the config PDA."}
          </p>
        </div>
        <div className="token-chip">
          <span className="token-dot" aria-hidden="true" />
          Mock USDC · 6 decimals
        </div>
      </div>

      <fieldset className="space-y-4" disabled={phase === "simulating" || phase === "signing"}>
        <legend className="sr-only">Split recipients</legend>
        <div className="recipient-header" aria-hidden="true">
          <span>Recipient wallet</span>
          <span>Share</span>
          <span />
        </div>
        {rows.map((row, index) => (
          <div className="recipient-row" key={row.id}>
            <div>
              <label className="mobile-label" htmlFor={`wallet-${row.id}`}>
                Recipient {index + 1} wallet
              </label>
              <input
                id={`wallet-${row.id}`}
                className="text-input font-mono"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="Solana wallet address"
                value={row.wallet}
                onChange={(event) => updateRow(row.id, { wallet: event.target.value })}
                required
              />
            </div>
            <div className="percent-field">
              <label className="mobile-label" htmlFor={`percent-${row.id}`}>
                Share percentage
              </label>
              <input
                id={`percent-${row.id}`}
                className="text-input pr-9 text-right font-mono tabular-nums"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={row.percent}
                onChange={(event) => updateRow(row.id, { percent: event.target.value })}
                aria-describedby={`percent-help-${row.id}`}
                required
              />
              <span className="percent-symbol" aria-hidden="true">
                %
              </span>
              <span id={`percent-help-${row.id}`} className="sr-only">
                Use at most two decimal places.
              </span>
            </div>
            <button
              type="button"
              className="icon-button"
              disabled={rows.length <= 2}
              onClick={() => {
                setRows((current) => current.filter((candidate) => candidate.id !== row.id));
                setPrepared(null);
                setPhase("idle");
              }}
              aria-label={`Remove recipient ${index + 1}`}
            >
              <Trash2 size={17} aria-hidden="true" />
            </button>
          </div>
        ))}
      </fieldset>

      <div className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          className="secondary-button"
          disabled={rows.length >= 5 || phase === "simulating" || phase === "signing"}
          onClick={() => {
            setRows((current) => [...current, { id: nextId, wallet: "", percent: "" }]);
            setNextId((value) => value + 1);
            setPrepared(null);
            setPhase("idle");
          }}
        >
          <Plus size={17} aria-hidden="true" /> Add recipient
        </button>
        <div className="allocation-total">
          <span>Total allocation</span>
          <strong
            className="font-mono tabular-nums"
            aria-label={`${(totalBps / 100).toFixed(2)} percent`}
          >
            {(totalBps / 100).toFixed(2)}%
          </strong>
          <span className={totalBps === 10_000 ? "text-success" : "text-danger"}>
            {totalBps === 10_000 ? "Ready" : "Must equal 100%"}
          </span>
        </div>
      </div>

      {withMilestones ? (
        <fieldset className="space-y-4 border-t border-line pt-6" disabled={busy}>
          <legend className="field-label">Project milestones</legend>
          <p className="field-help">1–5 milestones, six decimals maximum. Each uses the same approved split and can be paid once.</p>
          {milestones.map((milestone, index) => (
            <div className="grid grid-cols-[minmax(0,1fr)_44px] items-end gap-3 md:grid-cols-[minmax(0,1fr)_minmax(200px,0.6fr)_44px]" key={milestone.id}>
              <div className="col-span-2 md:col-span-1">
                <label className="field-label" htmlFor={`milestone-name-${milestone.id}`}>Milestone {index + 1} name</label>
                <input id={`milestone-name-${milestone.id}`} className="text-input" value={milestone.name} maxLength={32}
                  onChange={(event) => { setMilestones((current) => current.map((m) => m.id === milestone.id ? { ...m, name: event.target.value } : m)); setPrepared(null); setPhase("idle"); setError(null); }} />
              </div>
              <div>
                <label className="field-label" htmlFor={`milestone-amount-${milestone.id}`}>Milestone {index + 1} amount (mock USDC)</label>
                <input id={`milestone-amount-${milestone.id}`} className="text-input font-mono tabular-nums" inputMode="decimal" value={milestone.amount}
                  onChange={(event) => { setMilestones((current) => current.map((m) => m.id === milestone.id ? { ...m, amount: event.target.value } : m)); setPrepared(null); setPhase("idle"); setError(null); }} />
              </div>
              <button type="button" className="icon-button" disabled={milestones.length <= 1} aria-label={`Remove milestone ${index + 1}`}
                onClick={() => { setMilestones((current) => current.filter((m) => m.id !== milestone.id)); setPrepared(null); setPhase("idle"); }}><Trash2 size={17} aria-hidden="true" /></button>
            </div>
          ))}
          <button type="button" className="secondary-button" disabled={milestones.length >= 5}
            onClick={() => { setMilestones((current) => [...current, { id: nextMilestoneId, name: "", amount: "" }]); setNextMilestoneId((id) => id + 1); setPrepared(null); setPhase("idle"); }}>
            <Plus size={17} aria-hidden="true" /> Add milestone
          </button>
        </fieldset>
      ) : null}

      {error ? (
        <div className="error-banner" role="alert">
          <strong>Split request failed.</strong>
          <span className="whitespace-pre-wrap">{error}</span>
        </div>
      ) : null}

      {phase === "ready" && prepared && preparedForWallet && !validationReason ? (
        <div className="success-banner" role="status">
          <Check size={18} aria-hidden="true" />
          <div>
            <strong>Simulation passed.</strong>
            <p>{withMilestones ? "The proposal is ready. Signing creates a Pending agreement, not an active payment split." : "The config is ready. The next click opens your wallet signature request."}</p>
          </div>
        </div>
      ) : null}

      {phase === "success" && prepared ? (
        <div className="success-panel" role="status">
          <div className="success-icon" aria-hidden="true">
            <Check size={22} />
          </div>
          <div>
            <h2>{withMilestones ? "Split proposed · Pending approvals" : "Split created"}</h2>
            <p className="font-mono text-xs break-all">{prepared.splitConfig}</p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Link className="primary-button" href={`/pay/${prepared.splitConfig}`}>
                <Link2 size={17} aria-hidden="true" /> {withMilestones ? "Open approval / payment link" : "Open payment link"}
              </Link>
              {signature ? (
                <a
                  className="secondary-button"
                  href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Explorer <ExternalLink size={16} aria-hidden="true" />
                </a>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <div className="action-row">
          <button
            className="secondary-button flex-1"
            type="submit"
            disabled={!!validationReason || busy}
            aria-describedby={validationReason ? "create-split-reason" : undefined}
            aria-busy={phase === "simulating"}
          >
            {phase === "simulating" ? (
              <LoaderCircle className="spin" size={17} aria-hidden="true" />
            ) : null}
            {phase === "simulating" ? "Simulating…" : "Simulate config"}
          </button>
          <div className="cta-with-help">
            <button
              className="primary-button"
              type="button"
              disabled={!canCreate}
              aria-describedby={createReason ? "create-split-reason" : undefined}
              aria-busy={phase === "signing"}
              onClick={handleCreate}
            >
              {phase === "signing" ? (
                <LoaderCircle className="spin" size={17} aria-hidden="true" />
              ) : null}
              {phase === "signing" ? "Check wallet…" : withMilestones ? "Propose split" : "Create immutable split"}
            </button>
            {createReason ? (
              <p id="create-split-reason" className="field-help" role="status">{createReason}</p>
            ) : null}
          </div>
        </div>
      )}
    </form>
  );
}

