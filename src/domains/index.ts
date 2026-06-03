import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PibrarianConfig } from "../config";
import { createBooksTools } from "./books";
import { createExtractPanelsTool, comicsPlaceholderTools } from "./comics";
import { createMediaTools } from "./media";

/**
 * Domain registry. Maps domain names to their tool definitions.
 * Tools are registered at startup but kept inactive by default.
 */

export interface DomainInfo {
  name: string;
  label: string;
  description: string;
  tools: ToolDefinition<any, any>[];
}

export type DomainName = "books" | "comics" | "media";

export function buildDomains(
  cfg: PibrarianConfig,
): Map<DomainName, DomainInfo> {
  const domains = new Map<DomainName, DomainInfo>();
  const defaultDownloadDir = `${process.env.HOME}/pibrarian/downloads`;

  domains.set("books", {
    name: "books",
    label: "Books",
    description: "Ebook library (Calibre) — search, browse, read, metadata",
    tools: createBooksTools(cfg.calibre, defaultDownloadDir),
  });

  domains.set("comics", {
    name: "comics",
    label: "Comics",
    description: "Comic book library — search, read, panel extraction",
    tools: [createExtractPanelsTool(cfg.vision), ...comicsPlaceholderTools],
  });

  domains.set("media", {
    name: "media",
    label: "Media",
    description: "Video library (Jellyfin) — search movies/TV, download, scene extraction",
    tools: createMediaTools(cfg.jellyfin, cfg.sceneDetect, defaultDownloadDir),
  });

  return domains;
}

/**
 * Get all tool names for a domain.
 */
export function getDomainToolNames(
  domains: Map<DomainName, DomainInfo>,
  domainName: DomainName,
): string[] {
  const domain = domains.get(domainName);
  if (!domain) return [];
  return domain.tools.map((t) => t.name);
}

/**
 * Get all tool names across all domains.
 */
export function getAllDomainToolNames(
  domains: Map<DomainName, DomainInfo>,
): string[] {
  const names: string[] = [];
  for (const domain of domains.values()) {
    names.push(...domain.tools.map((t) => t.name));
  }
  return names;
}
