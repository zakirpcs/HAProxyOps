import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import { Panel } from "./ui";
import ConfirmDialog from "./ConfirmDialog";

/**
 * Edit and apply a node's whole configuration.
 *
 * The riskiest thing in the application: a bad config reloads a live load
 * balancer. Three things stand between an edit and an outage, and none of them
 * is the UI being careful - they are all enforced by HAProxy or the API:
 *
 * 1. **Validation is HAProxy's**, not a guess. The same check runs on apply, so
 *    an invalid config cannot be written even if this screen is bypassed.
 * 2. **The version is checked by the node.** An edit based on a stale read is
 *    refused rather than silently overwriting whoever got there first.
 * 3. **Validation is required before applying here.** The server would validate
 *    anyway; requiring it in the UI is what makes the operator *read* the
 *    result rather than clicking through it.
 */
export default function ConfigEditor({ nodeId, nodeName }: {
  nodeId: number; nodeName: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loaded = useQuery({
    queryKey: ["raw-config", nodeId],
    queryFn: () => api.rawConfig(nodeId),
    retry: false,
    staleTime: 30_000,
  });

  // A new node means a new file; carrying the previous draft across would be
  // a way to write one node's config onto another.
  useEffect(() => {
    setDraft(null);
    setNotice(null);
    setApplyError(null);
  }, [nodeId]);

  const original = loaded.data?.config ?? "";
  const version = loaded.data?.version ?? "";
  const text = draft ?? original;
  const dirty = draft !== null && draft !== original;

  const validate = useMutation({
    mutationFn: () => api.validateConfig(nodeId, text, version),
  });

  const apply = useMutation({
    mutationFn: () => api.applyConfig(nodeId, text, version),
    onSuccess: (r) => {
      setConfirming(false);
      setDraft(null);
      setNotice(`Applied ${r.lines} lines to ${r.node}. HAProxy reloaded.`);
      loaded.refetch();
      validate.reset();
    },
    onError: (e) => setApplyError(e instanceof Error ? e.message : "Apply failed"),
  });

  // Any edit invalidates a previous result: it was for different text.
  const validated = validate.data?.valid === true && !validate.isPending;

  if (loaded.isError) {
    // Match on the status, never the message: the API returns its own detail
    // text, which says nothing about which condition this is.
    const error = loaded.error;
    const status = error instanceof ApiError ? error.status : 0;
    return (
      <Panel title="Edit configuration">
        <p className="text-sm text-[var(--color-mute)]">
          {status === 501
            ? "This node's transport cannot read or write configuration."
            : status === 401 || status === 403
              ? "Editing configuration is available to administrators only."
              : (error as Error).message}
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title={`Edit configuration — ${nodeName}`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {dirty && (
            <button type="button"
                    onClick={() => { setDraft(null); validate.reset(); }}
                    className="rounded border border-ink-600 bg-ink-800 px-2 py-1 text-xs text-[var(--color-mute)] hover:text-slate-200">
              Discard changes
            </button>
          )}
          <button
            type="button"
            onClick={() => validate.mutate()}
            disabled={validate.isPending || !text}
            className="rounded border border-ink-600 bg-ink-800 px-2.5 py-1 text-xs text-slate-200 disabled:opacity-40"
          >
            {validate.isPending ? "Checking…" : "Validate"}
          </button>
          <button
            type="button"
            onClick={() => { setApplyError(null); setConfirming(true); }}
            disabled={!dirty || !validated}
            title={
              !dirty ? "Nothing has changed"
                : !validated ? "Validate the configuration first"
                  : "Apply and reload HAProxy"
            }
            className="rounded bg-[var(--color-down)] px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
          >
            Apply and reload
          </button>
        </div>
      }
    >
      {notice && (
        <p className="mb-2 rounded border border-[var(--color-up)]/40 bg-[var(--color-up)]/10 px-3 py-1.5 text-xs text-[var(--color-up)]">
          {notice}
        </p>
      )}

      {validate.data && (
        <p className={`mb-2 whitespace-pre-wrap rounded border px-3 py-1.5 text-xs ${
          validate.data.valid
            ? "border-[var(--color-up)]/40 bg-[var(--color-up)]/10 text-[var(--color-up)]"
            : "border-[var(--color-down)]/40 bg-[var(--color-down)]/10 text-[var(--color-down)]"
        }`}>
          {validate.data.message}
        </p>
      )}
      {validate.isError && (
        <p className="mb-2 rounded border border-[var(--color-down)]/40 bg-[var(--color-down)]/10 px-3 py-1.5 text-xs text-[var(--color-down)]">
          {(validate.error as Error).message}
        </p>
      )}

      <textarea
        value={text}
        onChange={(e) => { setDraft(e.target.value); validate.reset(); setNotice(null); }}
        spellCheck={false}
        aria-label={`Configuration for ${nodeName}`}
        className="h-[26rem] w-full resize-y rounded border border-ink-600 bg-ink-950 p-3 font-mono text-xs leading-relaxed text-slate-200 outline-none focus:border-[var(--color-accent)]"
      />

      <p className="mt-2 text-[11px] text-[var(--color-mute)]">
        {loaded.isLoading ? "Loading…" : (
          <>
            Version <span className="font-mono text-slate-300">{version}</span>,{" "}
            {text.split("\n").length} lines
            {dirty && <span className="text-[var(--color-drain)]"> · unsaved changes</span>}.
            {" "}Applying writes the whole file and reloads HAProxy. The node refuses
            the write if its configuration changed since this was read, so a
            concurrent edit cannot be overwritten.
            {" "}<strong className="text-[var(--color-drain)]">
              The Data Plane API rewrites the file rather than storing it verbatim
            </strong>{" "}
            — it adds its own <span className="font-mono">_md5hash</span> and{" "}
            <span className="font-mono">_version</span> header, re-indents, and drops
            bare comment lines. Directives survive; your formatting may not.
          </>
        )}
      </p>

      <ConfirmDialog
        open={confirming}
        title={`Apply this configuration to ${nodeName}?`}
        confirmLabel={`Apply to ${nodeName}`}
        variant="danger"
        busy={apply.isPending}
        error={applyError}
        onConfirm={() => apply.mutate()}
        onClose={() => !apply.isPending && setConfirming(false)}
      >
        <p>
          The whole file is written to <strong>{nodeName}</strong> and HAProxy reloads.
          Existing connections are handed to the new process; a config that is valid
          but wrong can still take the node out of service.
        </p>
        <p className="text-[var(--color-mute)]">
          HAProxy has already accepted this configuration as valid. That means it
          parses — not that it does what you intended.
        </p>
      </ConfirmDialog>
    </Panel>
  );
}
