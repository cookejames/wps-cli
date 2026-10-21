// Register every command here. Adding a command = one new file + one line below.
import { accountsBalances } from "./accounts-balances.ts";
import { accountsList } from "./accounts-list.ts";
import { categoriesList } from "./categories-list.ts";
import { devExtractCategories } from "./dev-extract-categories.ts";
import { sheetsBackfillSnapshots } from "./sheets-backfill-snapshots.ts";
import { sheetsInitDashboard } from "./sheets-init-dashboard.ts";
import { sheetsSync } from "./sheets-sync.ts";
import { networth } from "./networth.ts";
import { networthHistory } from "./networth-history.ts";
import { projectsList } from "./projects-list.ts";
import { sessionCheck } from "./session-check.ts";
import { transactionsList } from "./transactions-list.ts";
import type { CommandDef } from "./types.ts";

export const commands: CommandDef[] = [
  sessionCheck,
  transactionsList,
  accountsList,
  accountsBalances,
  networth,
  networthHistory,
  categoriesList,
  projectsList,
  devExtractCategories,
  sheetsSync,
  sheetsInitDashboard,
  sheetsBackfillSnapshots,
];

export function findCommand(group: string, name: string): CommandDef | undefined {
  return commands.find((c) => c.group === group && c.name === name);
}
