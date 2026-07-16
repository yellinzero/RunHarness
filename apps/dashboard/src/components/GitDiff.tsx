import { Diff, Hunk, parseDiff, type FileData } from "react-diff-view";
import "react-diff-view/style/index.css";
import { useI18n } from "../i18n/provider";

export function GitDiff({ status, diff }: { status: string; diff: string }) {
  const { t } = useI18n();
  const statusLines = status.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  let files: FileData[] = [];
  let parseFailed = false;
  if (diff.trim()) {
    try { files = parseDiff(diff, { nearbySequences: "zip" }); }
    catch { parseFailed = true; }
  }

  if (!statusLines.length && !diff.trim()) return <p className="diff-empty">{t("result.noDiff")}</p>;
  return <div className="git-diff">
    {statusLines.length > 0 && <section className="diff-status" aria-label={t("result.gitStatus")}>
      <h3>{t("result.gitStatus")}</h3>
      <ul>{statusLines.map((line, index) => <li key={`${line}-${index}`}><code>{line.slice(0, 2).trim() || "·"}</code><span>{line.slice(3).trim() || line.trim()}</span></li>)}</ul>
    </section>}
    {files.length > 0 && <div className="diff-files">{files.map((file, index) => <DiffFile key={`${file.oldPath}-${file.newPath}-${index}`} file={file} />)}</div>}
    {(parseFailed || (diff.trim() && files.length === 0)) && <details className="diff-raw" open><summary>{t("result.rawDiff")}</summary><pre>{diff}</pre></details>}
  </div>;
}

function DiffFile({ file }: { file: FileData }) {
  const { t } = useI18n();
  const path = file.type === "delete" ? file.oldPath : file.newPath;
  return <article className="diff-file">
    <header><strong>{path}</strong><span>{t(`result.changeType.${file.type}`)}</span></header>
    {file.isBinary || file.hunks.length === 0
      ? <p>{file.isBinary ? t("result.binaryDiff") : t("result.noTextDiff")}</p>
      : <div className="diff-table"><Diff viewType="unified" diffType={file.type} hunks={file.hunks}>{(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}</Diff></div>}
  </article>;
}
