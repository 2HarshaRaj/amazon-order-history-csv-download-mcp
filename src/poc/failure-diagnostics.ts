/** Owner-local evidence only. Never store raw DOM, URLs, exceptions, or extractor logs. */
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { constants, Stats } from "fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  chmod,
} from "fs/promises";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { promisify } from "util";
import { version as playwrightVersion } from "playwright/package.json";
import { z } from "zod";

export const DIAGNOSTIC_DIRECTORY = join(
  homedir(),
  ".amazon-order-history-poc",
  "failure-reports",
);
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_REPORTS = 50;
export const MAX_REPORT_BYTES = 128 * 1024;
const MAX_EVENTS = 200;
const MAX_LINES = 100;
const REPORT_NAME =
  /^failure-(\d{13})-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.json(?:\.tmp)?$/;

const failureStageSchema = z.enum([
  "browser",
  "list",
  "detail",
  "adjustments",
  "items",
  "invoice",
  "validation",
  "reconciliation",
  "output",
]);
export type FailureStage = z.infer<typeof failureStageSchema>;

const reasonCodeSchema = z.enum([
  "BROWSER_OPEN_FAILED",
  "LIST_NAVIGATION_FAILED",
  "LIST_SELECTOR_MISSING",
  "LIST_FACTS_MISSING",
  "DATE_RANGE_UNSUPPORTED",
  "DETAIL_NAVIGATION_FAILED",
  "DETAIL_SELECTOR_MISSING",
  "ADJUSTMENT_READ_FAILED",
  "ADJUSTMENT_AMOUNT_INVALID",
  "SUMMARY_SELECTOR_MISSING",
  "ITEM_EXTRACTION_FAILED",
  "ITEMS_EMPTY",
  "ITEM_ROW_FAILED",
  "ITEM_SHAPE_AMBIGUOUS",
  "ITEM_CONTAINERS",
  "STRATEGY_STARTED",
  "STRATEGY_EMPTY",
  "STRATEGY_FOUND",
  "STRATEGY_FAILED",
  "INVOICE_NAVIGATION_FAILED",
  "INVOICE_SELECTOR_MISSING",
  "INVOICE_EXTRACTION_FAILED",
  "INVOICE_ITEMS_EMPTY",
  "INVOICE_FALLBACK_USED",
  "CANCELLED_LIST_USED",
  "EXPORT_METADATA_INVALID",
  "ORDER_FACTS_INVALID",
  "ITEM_FACTS_INVALID",
  "ORDER_TOTAL_INVALID",
  "UNIT_PRICE_INVALID",
  "ITEM_TOTAL_INVALID",
  "TOTAL_MISMATCH",
  "OUTPUT_WRITE_FAILED",
  "AUTHENTICATION_REQUIRED",
]);
export type ReasonCode = z.infer<typeof reasonCodeSchema>;

type MoneyFact = { amount: number; currency: string } | undefined;
interface ItemFacts {
  asin?: string;
  productName: string;
  quantity: number;
  unitPrice?: MoneyFact;
  itemTotal?: MoneyFact;
}
interface SummaryFacts {
  orderId: string;
  orderDate: string;
  status?: string;
  orderTotal?: MoneyFact;
  cancelledItems?: ItemFacts[];
}
interface AdjustmentFacts {
  type: string;
  label: string;
  amount?: MoneyFact;
  extractionSource: string;
}
interface DetailFacts {
  extractionSource: string;
  items: ItemFacts[];
  adjustments: AdjustmentFacts[];
}

interface SummaryEvidence {
  orderId?: string;
  orderDate?: string;
  status?: "cancelled";
  orderTotalPaise?: number;
  currency: "INR";
}
interface ItemEvidence {
  lineIndex: number;
  asin?: string;
  productName?: string;
  quantity?: number;
  unitPricePaise?: number;
  itemTotalPaise?: number;
}
interface AdjustmentEvidence {
  adjustmentIndex: number;
  type?: string;
  label?: string;
  amountPaise?: number;
  extractionSource?: string;
}
interface DiagnosticEvent {
  stage: FailureStage;
  reason: ReasonCode;
  elapsedMs: number;
  orderIndex?: number;
  count?: number;
  strategyIndex?: number;
  category?: FailureReport["failure"]["category"];
}
interface StageTiming {
  stage: FailureStage;
  durationMs: number;
  orderIndex?: number;
}
interface Reconciliation {
  itemsPaise: number;
  adjustmentsPaise: number;
  expectedPaise: number;
  actualPaise: number;
  differencePaise: number;
  tolerancePaise: number;
}
export interface FailureReport {
  schemaVersion: number;
  runId: string;
  timestamp: string;
  failure: {
    stage: FailureStage;
    reason: ReasonCode;
    category:
      | "authentication"
      | "validation"
      | "timeout"
      | "filesystem-permission"
      | "storage-full"
      | "filesystem-path"
      | "operation-failed";
  };
  runtime: { node: string; playwright: string; chromium?: string };
  counts: {
    pagesScanned: number;
    selectedOrders: number;
    items: number;
    adjustments: number;
  };
  selectedOrders: SummaryEvidence[];
  order?: SummaryEvidence & { orderIndex: number };
  lineIndex?: number;
  adjustmentIndex?: number;
  items: ItemEvidence[];
  adjustments: AdjustmentEvidence[];
  extractionSource?: string;
  reconciliation?: Reconciliation;
  events: DiagnosticEvent[];
  timings: StageTiming[];
  truncated: boolean;
}

function category(
  error: unknown,
  authenticationRequired: boolean,
): FailureReport["failure"]["category"] {
  if (authenticationRequired) return "authentication";
  if (error instanceof DiagnosticError) return "validation";
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "timeout";
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return "filesystem-permission";
    if (code === "ENOSPC" || code === "EDQUOT") return "storage-full";
    if (["ENOENT", "ENOTDIR", "EISDIR", "EEXIST"].includes(code ?? ""))
      return "filesystem-path";
  }
  return "operation-failed";
}

const diagnosticMoney = z.object({
  amount: z.number().finite(),
  currency: z.literal("INR"),
});
const diagnosticTitle = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine(
    (value) =>
      ![...value].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) &&
      !/[<>]|https?:|www\.|@|\b(?:otp|cvv|password|credentials?|authorization|bearer|session|csrf|cookie|token|recipient|address|phone|email|upi|billing)\b|(?:\p{N}[\s()./+-]*){10,}/iu.test(
        value,
      ),
  );

const ORDER_ID =
  /^(?:\d{3}-\d{7}-\d{7}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
const ADJUSTMENT_LABEL =
  /^(?:(?:shipping|delivery)(?: (?:charge|fee|discount|promotion))?s?|marketplace fee|discount|promotion(?: applied)?|tax|gst|vat|gift wrap|cash\s*\/\s*pay on delivery fee)$/i;
const extractionSourceSchema = z.enum([
  "order-detail",
  "invoice-safe-fallback",
  "cancelled-order-list",
  "order-detail-summary",
]);
const categorySchema = z.enum([
  "authentication",
  "validation",
  "timeout",
  "filesystem-permission",
  "storage-full",
  "filesystem-path",
  "operation-failed",
]);
const paiseSchema = z.number().int().safe();
const countSchema = paiseSchema.nonnegative();
const orderIndexSchema = countSchema.max(49);
const versionSchema = z
  .string()
  .max(64)
  .regex(
    /^v?\d+\.\d+\.\d+(?:-(?:alpha|beta|rc|next|nightly|pre|canary)[\d.a-f-]*)?$/,
  );
const summaryEvidenceSchema = z
  .object({
    orderId: z.string().max(36).regex(ORDER_ID).optional(),
    orderDate: z
      .string()
      .max(10)
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((value) => {
        const parsed = new Date(`${value}T00:00:00.000Z`);
        return (
          Number.isFinite(parsed.getTime()) &&
          parsed.toISOString().slice(0, 10) === value
        );
      })
      .optional(),
    status: z.literal("cancelled").optional(),
    orderTotalPaise: paiseSchema.optional(),
    currency: z.literal("INR"),
  })
  .strict();

/** Independently validate every serializable field, including all nested objects.
 * Parsing creates a fresh data-only tree; caller properties/JSON hooks are never
 * passed through. Unknown keys and unsafe values reject the entire report. */
const failureReportSchema: z.ZodType<FailureReport> = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().max(36).uuid(),
    timestamp: z.string().max(40).datetime({ offset: true }),
    failure: z
      .object({
        stage: failureStageSchema,
        reason: reasonCodeSchema,
        category: categorySchema,
      })
      .strict(),
    runtime: z
      .object({
        node: versionSchema,
        playwright: versionSchema,
        chromium: z
          .string()
          .max(64)
          .regex(/^\d+(?:\.\d+){1,3}$/)
          .optional(),
      })
      .strict(),
    counts: z
      .object({
        pagesScanned: countSchema.max(20),
        selectedOrders: countSchema.max(50),
        items: countSchema,
        adjustments: countSchema,
      })
      .strict(),
    selectedOrders: z.array(summaryEvidenceSchema).max(50),
    order: summaryEvidenceSchema
      .extend({ orderIndex: orderIndexSchema })
      .strict()
      .optional(),
    lineIndex: countSchema.optional(),
    adjustmentIndex: countSchema.optional(),
    items: z
      .array(
        z
          .object({
            lineIndex: countSchema,
            asin: z
              .string()
              .max(10)
              .regex(/^[A-Z0-9]{10}$/)
              .optional(),
            productName: z
              .string()
              .refine((value) => value === value.trim())
              .pipe(diagnosticTitle)
              .optional(),
            quantity: countSchema.positive().optional(),
            unitPricePaise: paiseSchema.optional(),
            itemTotalPaise: paiseSchema.optional(),
          })
          .strict(),
      )
      .max(MAX_LINES),
    adjustments: z
      .array(
        z
          .object({
            adjustmentIndex: countSchema,
            type: z
              .enum([
                "shipping",
                "marketplace_fee",
                "discount",
                "promotion",
                "tax",
                "gift_wrap",
                "other",
              ])
              .optional(),
            label: z
              .string()
              .max(80)
              .regex(ADJUSTMENT_LABEL)
              .refine((value) =>
                [...value].every((character) => {
                  const code = character.charCodeAt(0);
                  return code >= 32 && code !== 127;
                }),
              )
              .optional(),
            amountPaise: paiseSchema.optional(),
            extractionSource: extractionSourceSchema.optional(),
          })
          .strict(),
      )
      .max(MAX_LINES),
    extractionSource: extractionSourceSchema.optional(),
    reconciliation: z
      .object({
        itemsPaise: paiseSchema,
        adjustmentsPaise: paiseSchema,
        expectedPaise: paiseSchema,
        actualPaise: paiseSchema,
        differencePaise: paiseSchema,
        tolerancePaise: z.literal(1),
      })
      .strict()
      .optional(),
    events: z
      .array(
        z
          .object({
            stage: failureStageSchema,
            reason: reasonCodeSchema,
            elapsedMs: countSchema,
            orderIndex: orderIndexSchema.optional(),
            count: countSchema.optional(),
            strategyIndex: countSchema.max(5).optional(),
            category: categorySchema.optional(),
          })
          .strict(),
      )
      .max(MAX_EVENTS),
    timings: z
      .array(
        z
          .object({
            stage: failureStageSchema,
            durationMs: countSchema,
            orderIndex: orderIndexSchema.optional(),
          })
          .strict(),
      )
      .max(MAX_EVENTS),
    truncated: z.boolean(),
  })
  .strict();

function paise(money: MoneyFact): number | undefined {
  const result = diagnosticMoney.safeParse(money);
  if (!result.success) return undefined;
  const value = Math.round(result.data.amount * 100);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** Fail closed on suspicious titles; do not try to salvage arbitrary private text. */
function productTitle(value: string): string | undefined {
  const result = diagnosticTitle.safeParse(value);
  return result.success ? result.data : undefined;
}

function source(value: string): string | undefined {
  return [
    "order-detail",
    "invoice-safe-fallback",
    "cancelled-order-list",
    "order-detail-summary",
  ].includes(value)
    ? value
    : undefined;
}

function summaryFacts(summary: SummaryFacts): SummaryEvidence {
  return {
    orderId: ORDER_ID.test(summary.orderId) ? summary.orderId : undefined,
    orderDate: /^\d{4}-\d{2}-\d{2}$/.test(summary.orderDate)
      ? summary.orderDate
      : undefined,
    status: summary.status === "cancelled" ? "cancelled" : undefined,
    orderTotalPaise: paise(summary.orderTotal),
    currency: "INR",
  };
}

function itemFacts(item: ItemFacts, lineIndex: number): ItemEvidence {
  return {
    lineIndex,
    asin: /^[A-Z0-9]{10}$/.test(item.asin ?? "") ? item.asin : undefined,
    productName: productTitle(item.productName),
    quantity:
      Number.isSafeInteger(item.quantity) && item.quantity > 0
        ? item.quantity
        : undefined,
    unitPricePaise: paise(item.unitPrice),
    itemTotalPaise: paise(item.itemTotal),
  };
}

function adjustmentFacts(
  adjustment: AdjustmentFacts,
  adjustmentIndex: number,
): AdjustmentEvidence {
  const allowedType = [
    "shipping",
    "marketplace_fee",
    "discount",
    "promotion",
    "tax",
    "gift_wrap",
    "other",
  ].includes(adjustment.type)
    ? adjustment.type
    : undefined;
  // Unknown summary labels can contain contact/payment data. Only retain known fee labels.
  const label = ADJUSTMENT_LABEL.test(adjustment.label)
    ? adjustment.label
    : undefined;
  return {
    adjustmentIndex,
    type: allowedType,
    label,
    amountPaise: paise(adjustment.amount),
    extractionSource: source(adjustment.extractionSource),
  };
}

export class DiagnosticError extends Error {
  constructor(
    readonly stage: FailureStage,
    readonly reason: ReasonCode,
    message: string,
  ) {
    super(message);
  }
}

export class FailureDiagnostics {
  readonly runId = randomUUID();
  private readonly started = Date.now();
  private stageStarted = this.started;
  private stageOrderIndex?: number;
  private stage: FailureStage = "list";
  private reason: ReasonCode = "LIST_NAVIGATION_FAILED";
  private events: DiagnosticEvent[] = [];
  private timings: StageTiming[] = [];
  private selected: ReturnType<typeof summaryFacts>[] = [];
  private order?: ReturnType<typeof summaryFacts> & { orderIndex: number };
  private items: ReturnType<typeof itemFacts>[] = [];
  private adjustments: ReturnType<typeof adjustmentFacts>[] = [];
  private extractionSource?: string;
  private itemCount = 0;
  private adjustmentCount = 0;
  private lineIndex?: number;
  private adjustmentIndex?: number;
  private reconciliation?: Reconciliation;
  private pagesScanned = 0;
  private chromiumVersion?: string;

  at(stage: FailureStage, reason: ReasonCode): void {
    if (this.timings.length >= MAX_EVENTS - 1) this.timings.shift();
    this.timings.push({
      stage: this.stage,
      durationMs: Math.max(0, Date.now() - this.stageStarted),
      orderIndex: this.stageOrderIndex,
    });
    this.stage = stage;
    this.reason = reason;
    this.stageStarted = Date.now();
    this.stageOrderIndex = this.order?.orderIndex;
  }
  note(
    stage: FailureStage,
    reason: ReasonCode,
    count?: number,
    strategyIndex?: number,
  ): void {
    if (this.events.length >= MAX_EVENTS) this.events.shift();
    this.events.push({
      stage,
      reason,
      elapsedMs: Math.max(0, Date.now() - this.started),
      orderIndex: this.order?.orderIndex,
      strategyIndex,
      count:
        Number.isSafeInteger(count) && (count as number) >= 0
          ? count
          : undefined,
    });
  }
  noteFailure(stage: FailureStage, reason: ReasonCode, error: unknown): void {
    this.note(stage, reason);
    this.events[this.events.length - 1].category = category(error, false);
  }
  browserVersion(version: string | undefined): void {
    if (version && /^\d+(?:\.\d+){1,3}$/.test(version))
      this.chromiumVersion = version;
  }
  listed(orders: SummaryFacts[], pagesScanned: number): void {
    this.selected = orders.slice(0, 50).map(summaryFacts);
    this.pagesScanned =
      Number.isSafeInteger(pagesScanned) && pagesScanned >= 0
        ? pagesScanned
        : 0;
  }
  select(summary: SummaryFacts, orderIndex: number): void {
    this.order = { ...summaryFacts(summary), orderIndex };
    this.captureItems(summary.cancelledItems ?? []);
    this.captureAdjustments([]);
    this.extractionSource = undefined;
    this.lineIndex = undefined;
    this.adjustmentIndex = undefined;
    this.reconciliation = undefined;
  }
  captureItems(items: ItemFacts[]): void {
    this.itemCount = items.length;
    this.items = items.slice(0, MAX_LINES).map(itemFacts);
  }
  captureAdjustments(adjustments: AdjustmentFacts[]): void {
    this.adjustmentCount = adjustments.length;
    this.adjustments = adjustments.slice(0, MAX_LINES).map(adjustmentFacts);
  }
  provenance(extractionSource: string): void {
    this.extractionSource = source(extractionSource);
  }
  detail(detail: DetailFacts): void {
    this.captureItems(detail.items);
    this.captureAdjustments(detail.adjustments);
    this.extractionSource = source(detail.extractionSource);
  }
  item(index: number): void {
    this.lineIndex = index;
  }
  adjustment(index: number): void {
    this.adjustmentIndex = index;
  }
  reconcile(
    itemsPaise: number,
    adjustmentsPaise: number,
    expectedPaise: number,
  ): void {
    this.at("reconciliation", "TOTAL_MISMATCH");
    this.reconciliation = {
      itemsPaise,
      adjustmentsPaise,
      expectedPaise,
      actualPaise: itemsPaise + adjustmentsPaise,
      differencePaise: itemsPaise + adjustmentsPaise - expectedPaise,
      tolerancePaise: 1,
    };
  }
  /** Translate only known technical shapes. Never retain or forward the message. */
  readonly itemDiagnostics = (message: string): void => {
    const strategy =
      /^Strategy([0-5]) \([^\n]*\) (found (\d+) items|returned no items|failed:)/.exec(
        message,
      );
    const started = /^Trying Strategy([0-5]) \([^\n]*\)\.\.\.$/.exec(message);
    const containers = /^Data components: Found (\d+) item containers$/.exec(
      message,
    );
    const stage = this.stage === "invoice" ? "invoice" : "items";
    if (started)
      this.note(stage, "STRATEGY_STARTED", undefined, Number(started[1]));
    else if (strategy)
      this.note(
        stage,
        strategy[2].startsWith("found")
          ? "STRATEGY_FOUND"
          : strategy[2].startsWith("failed")
            ? "STRATEGY_FAILED"
            : "STRATEGY_EMPTY",
        strategy[3] ? Number(strategy[3]) : undefined,
        Number(strategy[1]),
      );
    else if (containers)
      this.note(stage, "ITEM_CONTAINERS", Number(containers[1]));
    else if (
      /^(?:Data components: Error extracting item:|Strategy[0-5]: Error:)/.test(
        message,
      )
    )
      this.note(stage, "ITEM_ROW_FAILED");
    else if (
      message.startsWith("Data components: Skipping ambiguous container")
    )
      this.note(stage, "ITEM_SHAPE_AMBIGUOUS");
  };
  report(error: unknown, authenticationRequired = false): FailureReport {
    const stage = error instanceof DiagnosticError ? error.stage : this.stage;
    const reason = authenticationRequired
      ? "AUTHENTICATION_REQUIRED"
      : error instanceof DiagnosticError
        ? error.reason
        : this.reason;
    return {
      schemaVersion: 1,
      runId: this.runId,
      timestamp: new Date().toISOString(),
      failure: {
        stage,
        reason,
        category: category(error, authenticationRequired),
      },
      runtime: {
        node: process.version,
        playwright: playwrightVersion,
        chromium: this.chromiumVersion,
      },
      counts: {
        pagesScanned: this.pagesScanned,
        selectedOrders: this.selected.length,
        items: this.itemCount,
        adjustments: this.adjustmentCount,
      },
      selectedOrders: this.selected,
      order: this.order,
      lineIndex: this.lineIndex,
      adjustmentIndex: this.adjustmentIndex,
      items: this.items,
      adjustments: this.adjustments,
      extractionSource: this.extractionSource,
      reconciliation: this.reconciliation,
      events: this.events,
      timings: [
        ...this.timings,
        {
          stage: this.stage,
          durationMs: Math.max(0, Date.now() - this.stageStarted),
          orderIndex: this.stageOrderIndex,
        },
      ],
      truncated:
        this.events.length >= MAX_EVENTS ||
        this.timings.length >= MAX_EVENTS - 1 ||
        this.itemCount > MAX_LINES ||
        this.adjustmentCount > MAX_LINES,
    };
  }
}

/** No raw exception interpolation, even for an Error with a hostile message/stack. */
export function safeFailureMessage(report: FailureReport): string {
  return `Amazon export failed: stage=${report.failure.stage}; code=${report.failure.reason}. See owner-local failure reports (README).`;
}

async function statEntry(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function privateDirectory(directory: string): Promise<string> {
  const absolute = resolve(directory);
  // Refuse symlinks/reparse links and any directory nested within a Git checkout.
  let cursor = absolute;
  for (;;) {
    const info = await statEntry(cursor);
    if (info?.isSymbolicLink() || (info && !info.isDirectory()))
      throw new Error("Unsafe diagnostic directory.");
    const gitMarker = await statEntry(join(cursor, ".git"));
    // Some sandboxes reserve empty .git directories. A Git directory requires
    // HEAD; a .git file/link can point to another worktree and is rejected.
    const gitHead = gitMarker?.isDirectory()
      ? await statEntry(join(cursor, ".git", "HEAD"))
      : undefined;
    const bareHead = !gitMarker
      ? await statEntry(join(cursor, "HEAD"))
      : undefined;
    const bareObjects = bareHead?.isFile()
      ? await statEntry(join(cursor, "objects"))
      : undefined;
    if (
      (gitMarker && (!gitMarker.isDirectory() || gitHead)) ||
      bareObjects?.isDirectory()
    )
      throw new Error("Diagnostic directory must be outside repositories.");
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  if ((await realpath(absolute)) !== absolute)
    throw new Error("Unsafe diagnostic directory.");
  const info = await lstat(absolute);
  if (process.platform === "win32") {
    // POSIX modes do not restrict Windows ACLs. Replace the directory ACL with
    // the current user's SID only; children inherit it. Paths are data, not code.
    await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        '$u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object System.Security.AccessControl.DirectorySecurity; $a.SetOwner($u); $a.SetAccessRuleProtection($true,$false); $r=New-Object System.Security.AccessControl.FileSystemAccessRule($u,"FullControl","ContainerInherit,ObjectInherit","None","Allow"); $a.AddAccessRule($r); Set-Acl -LiteralPath $env:AMAZON_DIAGNOSTIC_ACL_PATH -AclObject $a -ErrorAction Stop',
      ],
      {
        env: { ...process.env, AMAZON_DIAGNOSTIC_ACL_PATH: absolute },
        timeout: 10000,
        windowsHide: true,
      },
    );
  } else {
    if (info.uid !== process.getuid?.())
      throw new Error("Diagnostic directory has another owner.");
    await chmod(absolute, 0o700);
  }
  return absolute;
}

async function cleanupDirectory(
  directory: string,
  now: number,
  enforceCapacity: boolean,
): Promise<void> {
  const retained: Array<{ name: string; time: number; size: number }> = [];
  for (const name of await readdir(directory)) {
    const match = REPORT_NAME.exec(name);
    if (!match) continue;
    const path = join(directory, name);
    const info = await lstat(path);
    // Never follow or remove links, subdirectories, or files owned by another user.
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      (process.platform !== "win32" && info.uid !== process.getuid?.())
    )
      continue;
    const time = Number(match[1]);
    if (
      time <= now - RETENTION_MS ||
      info.size > MAX_REPORT_BYTES ||
      (name.endsWith(".tmp") && info.mtimeMs < now - 60 * 60 * 1000)
    )
      await unlink(path);
    else retained.push({ name, time, size: info.size });
  }
  if (!enforceCapacity) return;
  retained.sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
  for (const entry of retained.slice(MAX_REPORTS))
    await unlink(join(directory, entry.name));
}

export async function cleanupFailureReports(
  directory = DIAGNOSTIC_DIRECTORY,
  now = Date.now(),
): Promise<void> {
  await cleanupDirectory(await privateDirectory(directory), now, true);
}

export async function writeFailureReport(
  report: unknown,
  directory = DIAGNOSTIC_DIRECTORY,
  now = Date.now(),
): Promise<void> {
  let bounded: FailureReport;
  try {
    bounded = failureReportSchema.parse(report);
  } catch {
    // Zod errors may include attacker-controlled keys/values. Never expose them.
    throw new Error("Diagnostic report failed safety validation.");
  }
  let serialized = `${JSON.stringify(bounded, null, 2)}\n`;
  while (Buffer.byteLength(serialized, "utf8") > MAX_REPORT_BYTES) {
    bounded.truncated = true;
    bounded.events = bounded.events.slice(
      -Math.floor(bounded.events.length / 2),
    );
    bounded.timings = bounded.timings.slice(
      -Math.floor(bounded.timings.length / 2),
    );
    bounded.items =
      bounded.items.length > 1
        ? [
            bounded.items.find(
              (item) => item.lineIndex === bounded.lineIndex,
            ) ?? bounded.items[0],
          ]
        : bounded.items;
    bounded.adjustments =
      bounded.adjustments.length > 1
        ? [
            bounded.adjustments.find(
              (item) => item.adjustmentIndex === bounded.adjustmentIndex,
            ) ?? bounded.adjustments[0],
          ]
        : bounded.adjustments;
    serialized = `${JSON.stringify(bounded, null, 2)}\n`;
    if (
      bounded.events.length <= 1 &&
      bounded.timings.length <= 1 &&
      Buffer.byteLength(serialized, "utf8") > MAX_REPORT_BYTES
    )
      throw new Error("Diagnostic report exceeds size bound.");
  }
  const root = await privateDirectory(directory);
  // Expiry/invalid-file cleanup is safe before publication. Valid reports must
  // not be evicted until the replacement has been atomically published.
  await cleanupDirectory(root, now, false);
  const output = join(root, `failure-${now}-${randomUUID()}.json`);
  const temporary = `${output}.tmp`;
  try {
    const file = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await file.writeFile(serialized, "utf8");
    } finally {
      await file.close();
    }
    await rename(temporary, output);
    await cleanupDirectory(root, now, true);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
