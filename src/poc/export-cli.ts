#!/usr/bin/env node
import * as path from "path";
import { chromium } from "playwright";
import { z } from "zod";
import { AmazonPlugin } from "../amazon/adapter";
import { fetchOrders } from "../tools/fetch-orders";
import { createPocExport, writePocExport } from "./export-contract";

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

const dateArgument = z
  .string()
  .refine(isCalendarDate, "must be a valid YYYY-MM-DD date");

const optionsSchema = z
  .object({
    startDate: dateArgument,
    endDate: dateArgument,
    maxOrders: z.number().int().positive().max(50),
    output: z.string().min(1),
  })
  .refine(
    (value) => value.startDate <= value.endDate,
    "start date must not follow end date",
  );

function parseArgs(argv: string[]): z.infer<typeof optionsSchema> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined)
      throw new Error("Arguments must be --name value pairs");
    values[flag.slice(2)] = value;
  }
  return optionsSchema.parse({
    startDate: values["start-date"],
    endDate: values["end-date"],
    maxOrders:
      values["max-orders"] === undefined ? 20 : Number(values["max-orders"]),
    output: values.output,
  });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const outputPath = path.resolve(options.output);
  const repositoryPath = `${path.resolve(process.cwd())}${path.sep}`;
  if (
    outputPath === path.resolve(process.cwd()) ||
    outputPath.startsWith(repositoryPath)
  ) {
    throw new Error("--output must be outside the repository");
  }
  const profile = path.resolve(
    process.cwd(),
    ".browser-data",
    "hardened-amazon-in",
  );
  console.error(
    "Opening visible Chromium with the dedicated local Amazon.in profile...",
  );
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const plugin = new AmazonPlugin();
    // The shared extractor is noisy by design for MCP diagnostics. Suppress it here so
    // no order IDs, names, or monetary values can cross the CLI logging boundary.
    const originalError = console.error;
    let result;
    try {
      console.error = () => undefined;
      result = await fetchOrders(page, plugin, {
        region: "in",
        startDate: options.startDate,
        endDate: options.endDate,
        maxOrders: options.maxOrders,
        includeItems: true,
        includeShipments: false,
        includeTransactions: false,
        useInvoice: true,
      });
    } finally {
      console.error = originalError;
    }
    if (result.errors.some((error) => error.startsWith("Not authenticated:"))) {
      throw new Error(
        "Amazon.in sign-in is required. Complete sign-in in visible Chromium, then rerun the command.",
      );
    }
    if (result.errors.length > 0)
      throw new Error(
        `Extraction failed with ${result.errors.length} error(s); no file was written.`,
      );
    const payload = createPocExport(result, options.startDate, options.endDate);
    await writePocExport(outputPath, payload);
    console.error(
      `Export complete: ${payload.orders.length} order(s), ${payload.metadata.pagesScanned} page(s) scanned.`,
    );
  } finally {
    await context.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Unknown export error";
    console.error(`Export failed: ${message.slice(0, 300)}`);
    process.exitCode = 1;
  });
}
