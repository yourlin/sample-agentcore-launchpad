/**
 * The annotation and calibration bench — §7.4.
 *
 * "The judge agrees with us" is a measurement, not an impression, so this page is
 * built around three numbers: human–human κ (is the criterion even writable?),
 * judge–human κ with its bootstrap interval (can the judge stand in for a person?),
 * and the confusion cells (where it is wrong). Labelling is blind — the judge's
 * verdict is withheld from an annotator until the task closes — and `aligned` is
 * refused by the server when the numbers do not support it, so the human chooses
 * only between the readings the data allows.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../../auth/auth-context";
import { dlcApi, errorMessage } from "../../../lib/api";
import type { AnnotationTask } from "../../../lib/dlc";
import { useLoad, useV2Toast } from "../../hooks";
import {
  Alert,
  Button,
  Card,
  Field,
  Kpi,
  LinkButton,
  Modal,
  Segmented,
  Select,
  Spin,
  Table,
  Tag,
} from "../../ui";
import { ConfusionMatrix } from "./charts";

const LABELS = ["pass", "fail", "inconclusive"] as const;

function TaskBench({ taskId, onBack }: { taskId: string; onBack: () => void }) {
  const { t } = useTranslation();
  const { can, username } = useAuth();
  const toast = useV2Toast();
  const [nonce, setNonce] = useState(0);
  const task = useLoad(() => dlcApi.getTask(taskId), `task:${taskId}:${nonce}`);
  const agreement = useLoad(() => dlcApi.agreement(taskId), `agreement:${taskId}:${nonce}`);
  const [deciding, setDeciding] = useState<"aligned" | "not_aligned" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const data = task.data;
  const measured = agreement.data;
  const mayDecide = can("judge.calibrate");

  const label = (ref: string, value: string) => {
    setBusy(true);
    dlcApi
      .label(taskId, { item_ref: ref, label: value })
      .then(() => setNonce((n) => n + 1))
      .catch((error: unknown) => toast("error", errorMessage(error)))
      .finally(() => setBusy(false));
  };

  const decide = () => {
    const verdict = deciding;
    setDeciding(null);
    if (!verdict) return;
    setBusy(true);
    dlcApi
      .decideCalibration(taskId, verdict, note)
      .then(() => {
        toast("success", t("v2.dlc.calibration.decided"));
        setNonce((n) => n + 1);
      })
      .catch((error: unknown) => toast("error", errorMessage(error)))
      .finally(() => setBusy(false));
  };

  if (task.loading && !data) return <Spin />;
  if (!data) return <Alert tone="error">{task.error ?? t("v2.dlc.calibration.notFound")}</Alert>;

  const blind = data.status !== "closed" && !mayDecide;
  const mine = data.items.filter((i) => i.my_label).length;

  return (
    <>
      <Card
        title={t("v2.dlc.calibration.taskTitle", { key: data.criterion_key })}
        sub={t(`v2.dlc.calibration.purpose.${data.purpose}`)}
        end={
          <>
            <Tag tone={data.status === "closed" ? "green" : "orange"}>
              {t(`v2.dlc.calibration.taskStatus.${data.status}`)}
            </Tag>
            <LinkButton onClick={onBack}>{t("v2.common.back")}</LinkButton>
          </>
        }
      >
        <div className="v2-dlc-kpis">
          <Kpi label={t("v2.dlc.calibration.items")} value={String(data.total)} />
          <Kpi label={t("v2.dlc.calibration.mine")} value={`${mine} / ${data.total}`} />
          <Kpi
            label={t("v2.dlc.calibration.annotators")}
            value={data.annotators.map((a) => `${a} (${data.progress[a] ?? 0})`).join(", ")}
          />
        </div>
        {blind && <Alert>{t("v2.dlc.calibration.blindHint")}</Alert>}
      </Card>

      {measured && (
        <Card title={t("v2.dlc.calibration.agreement")} sub={t("v2.dlc.calibration.agreementSub")}>
          <div className="v2-dlc-split2">
            <div>
              <div className="v2-dlc-kpis">
                <Kpi
                  label={t("v2.dlc.calibration.humanKappa")}
                  value={measured.human_human_kappa === null ? "—" : measured.human_human_kappa.toFixed(2)}
                  sub={measured.human_band ? t(`v2.dlc.kappaBand.${measured.human_band}`) : undefined}
                />
                <Kpi
                  label={t("v2.dlc.calibration.judgeKappa")}
                  value={measured.judge_human_kappa === null ? "—" : measured.judge_human_kappa.toFixed(2)}
                  sub={measured.band ? t(`v2.dlc.kappaBand.${measured.band}`) : undefined}
                />
                <Kpi label={t("v2.dlc.calibration.n")} value={String(measured.n)} />
                <Kpi
                  label={t("v2.dlc.calibration.floor")}
                  value={measured.policy.kappa_floor.toFixed(2)}
                  sub={t("v2.dlc.calibration.period", { days: measured.policy.period_days })}
                />
              </div>
              {measured.human_human_kappa !== null && measured.human_human_kappa < 0.6 && (
                <Alert tone="warn">{t("v2.dlc.calibration.humansDisagree")}</Alert>
              )}
              {measured.suggested_verdict === "insufficient_n" && (
                <Alert tone="warn">{t("v2.dlc.calibration.needMore")}</Alert>
              )}
            </div>
            <ConfusionMatrix
              confusion={measured.confusion}
              kappa={measured.judge_human_kappa}
              ci={measured.kappa_ci}
            />
          </div>
          {measured.disagreements.length > 0 && (
            <>
              <h4>{t("v2.dlc.calibration.disagreements")}</h4>
              <table className="v2-table dense">
                <thead>
                  <tr>
                    <th>{t("v2.dlc.calibration.item")}</th>
                    <th>{t("v2.dlc.calibration.humanCol")}</th>
                    <th>{t("v2.dlc.calibration.judgeCol")}</th>
                    <th>{t("v2.dlc.calibration.judgeSaid")}</th>
                  </tr>
                </thead>
                <tbody>
                  {measured.disagreements.slice(0, 20).map((d) => (
                    <tr key={d.ref}>
                      <td className="mono">{d.ref}</td>
                      <td>
                        {d.needs_adjudication ? (
                          <Tag tone="orange">{t("v2.dlc.calibration.needsAdjudication")}</Tag>
                        ) : (
                          (d.human ?? "—")
                        )}
                      </td>
                      <td>{d.judge ?? "—"}</td>
                      <td className="v2-muted">{d.judge_explanation ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {mayDecide && data.status !== "closed" && (
            <div className="v2-dlc-actions">
              <Button
                kind="primary"
                disabled={busy || measured.suggested_verdict !== "aligned"}
                title={
                  measured.suggested_verdict !== "aligned" ? t("v2.dlc.calibration.cannotAlign") : undefined
                }
                onClick={() => {
                  setNote("");
                  setDeciding("aligned");
                }}
              >
                {t("v2.dlc.calibration.markAligned")}
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  setNote("");
                  setDeciding("not_aligned");
                }}
              >
                {t("v2.dlc.calibration.markNotAligned")}
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  dlcApi
                    .adjudicate(taskId)
                    .then(() => setNonce((n) => n + 1))
                    .catch((error: unknown) => toast("error", errorMessage(error)))
                    .finally(() => setBusy(false));
                }}
              >
                {t("v2.dlc.calibration.adjudicate")}
              </Button>
            </div>
          )}
        </Card>
      )}

      <Card title={t("v2.dlc.calibration.label")} sub={t("v2.dlc.calibration.labelSub")} flush>
        <table className="v2-table">
          <thead>
            <tr>
              <th>{t("v2.dlc.calibration.item")}</th>
              <th>{t("v2.dlc.admission.question")}</th>
              <th>{t("v2.dlc.calibration.answer")}</th>
              <th>{t("v2.dlc.calibration.myLabel")}</th>
              {!blind && <th>{t("v2.dlc.calibration.judgeCol")}</th>}
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.ref}>
                <td className="mono">{item.ref}</td>
                <td>{item.input ?? "—"}</td>
                <td className="v2-muted">{item.answer ?? "—"}</td>
                <td>
                  {data.annotators.includes(username ?? "") && data.status !== "closed" ? (
                    <Segmented
                      value={(item.my_label ?? "") as string}
                      onChange={(v) => label(item.ref, v)}
                      options={LABELS.map((l) => ({ value: l, label: t(`v2.dlc.label.${l}`) }))}
                    />
                  ) : (
                    (item.my_label ?? "—")
                  )}
                </td>
                {!blind && <td>{item.judge_label ?? "—"}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Modal
        open={deciding !== null}
        title={t("v2.dlc.calibration.decideTitle")}
        onClose={() => setDeciding(null)}
        footer={
          <>
            <Button onClick={() => setDeciding(null)}>{t("v2.common.cancel")}</Button>
            <Button kind="primary" disabled={busy} onClick={decide}>
              {t("v2.common.confirm")}
            </Button>
          </>
        }
      >
        <p className="v2-muted">
          {deciding === "aligned" ? t("v2.dlc.calibration.alignedHint") : t("v2.dlc.calibration.notAlignedHint")}
        </p>
        <Field label={t("v2.dlc.calibration.note")}>
          <textarea className="v2-input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </Modal>
    </>
  );
}

function NewTask({
  agentId,
  lineageId,
  criteriaKeys,
  people,
  onCreated,
}: {
  agentId: string | null;
  lineageId: string | null;
  criteriaKeys: string[];
  people: string[];
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useV2Toast();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(criteriaKeys[0] ?? "");
  const [runId, setRunId] = useState("");
  const [annotators, setAnnotators] = useState<string[]>([]);
  const [adjudicator, setAdjudicator] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <>
      <Button kind="primary" size="sm" onClick={() => setOpen(true)}>
        {t("v2.dlc.calibration.newTask")}
      </Button>
      <Modal
        open={open}
        title={t("v2.dlc.calibration.newTaskTitle")}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t("v2.common.cancel")}</Button>
            <Button
              kind="primary"
              disabled={busy || !key || annotators.length < 2 || !runId}
              onClick={() => {
                setBusy(true);
                dlcApi
                  .createTask({
                    agent_id: agentId,
                    criteria_lineage_id: lineageId,
                    criterion_key: key,
                    annotators,
                    adjudicator: adjudicator || null,
                    run_id: runId,
                  })
                  .then((created) => {
                    toast("success", t("v2.dlc.calibration.taskCreated"));
                    setOpen(false);
                    onCreated(created.id);
                  })
                  .catch((error: unknown) => toast("error", errorMessage(error)))
                  .finally(() => setBusy(false));
              }}
            >
              {t("v2.common.save")}
            </Button>
          </>
        }
      >
        <p className="v2-muted">{t("v2.dlc.calibration.newTaskHint")}</p>
        <Field label={t("v2.dlc.criteria.key")} required>
          <Select
            value={key}
            onChange={setKey}
            options={criteriaKeys.map((k) => ({ value: k, label: k }))}
            placeholder={t("v2.dlc.calibration.pickCriterion")}
          />
        </Field>
        <Field label={t("v2.dlc.calibration.fromRun")} required hint={t("v2.dlc.calibration.fromRunHint")}>
          <input className="v2-input mono" value={runId} onChange={(e) => setRunId(e.target.value)} />
        </Field>
        <Field label={t("v2.dlc.calibration.annotators")} required hint={t("v2.dlc.calibration.annotatorsHint")}>
          <div className="v2-dlc-keys">
            {people.map((person) => (
              <label key={person}>
                <input
                  type="checkbox"
                  checked={annotators.includes(person)}
                  onChange={(e) =>
                    setAnnotators((prev) =>
                      e.target.checked ? [...prev, person] : prev.filter((p) => p !== person),
                    )
                  }
                />
                <span>{person}</span>
              </label>
            ))}
          </div>
        </Field>
        <Field label={t("v2.dlc.calibration.adjudicator")} hint={t("v2.dlc.calibration.adjudicatorHint")}>
          <Select
            value={adjudicator}
            onChange={setAdjudicator}
            options={people.map((p) => ({ value: p, label: p }))}
            placeholder={t("v2.dlc.calibration.noAdjudicator")}
          />
        </Field>
      </Modal>
    </>
  );
}

export function CalibrationBench({
  agentId,
  lineageId,
  criteriaKeys,
  people,
  taskId,
  onOpenTask,
}: {
  agentId: string | null;
  lineageId: string | null;
  criteriaKeys: string[];
  people: string[];
  taskId: string | null;
  onOpenTask: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const [nonce, setNonce] = useState(0);
  const tasks = useLoad<{ tasks: AnnotationTask[] }>(
    () => dlcApi.listTasks({ agentId: agentId ?? undefined }),
    `tasks:${agentId ?? ""}:${nonce}`,
  );

  if (taskId) return <TaskBench taskId={taskId} onBack={() => onOpenTask(null)} />;

  return (
    <Card
      title={t("v2.dlc.calibration.title")}
      sub={t("v2.dlc.calibration.sub")}
      end={
        <NewTask
          agentId={agentId}
          lineageId={lineageId}
          criteriaKeys={criteriaKeys}
          people={people}
          onCreated={(id) => {
            setNonce((n) => n + 1);
            onOpenTask(id);
          }}
        />
      }
    >
      <Table
        rows={tasks.data?.tasks ?? []}
        rowKey={(row) => row.id}
        loading={tasks.loading}
        error={tasks.error}
        onRetry={tasks.reload}
        empty={t("v2.dlc.calibration.noTasks")}
        columns={[
          { key: "key", title: t("v2.dlc.criteria.key"), render: (row) => <span className="mono">{row.criterion_key}</span> },
          { key: "purpose", title: t("v2.dlc.calibration.purposeCol"), render: (row) => t(`v2.dlc.calibration.purpose.${row.purpose}`) },
          {
            key: "status",
            title: t("v2.common.status"),
            render: (row) => (
              <Tag tone={row.status === "closed" ? "green" : "orange"}>
                {t(`v2.dlc.calibration.taskStatus.${row.status}`)}
              </Tag>
            ),
          },
          {
            key: "progress",
            title: t("v2.dlc.calibration.progress"),
            render: (row) =>
              row.annotators.map((a) => `${a}: ${row.progress[a] ?? 0}/${row.total}`).join(" · "),
          },
          { key: "act", title: "", render: (row) => <LinkButton onClick={() => onOpenTask(row.id)}>{t("v2.common.open")}</LinkButton> },
        ]}
      />
    </Card>
  );
}
