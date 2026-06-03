import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveJellyfinAuth, type PibrarianConfig } from "./config";
import { buildDomains, getDomainToolNames, getAllDomainToolNames, type DomainName } from "./domains";

/**
 * Pibrarian — Multi-domain content library extension for pi.
 *
 * Domains: books (Calibre), comics (Komga), media (Jellyfin movies+TV)
 *
 * All tools are registered at startup but kept inactive by default.
 * Activate domains via /pibrarian-activate <domain> or /pibrarian-activate all.
 * State persists across reloads via pi.appendEntry().
 */

interface PibrarianState {
  activeDomains: DomainName[];
}

export default function (pi: ExtensionAPI) {
  let config: PibrarianConfig;
  let domains: ReturnType<typeof buildDomains>;
  let activeDomains: Set<DomainName> = new Set();

  // --- State persistence ---

  function persistState() {
    pi.appendEntry<PibrarianState>("pibrarian-state", {
      activeDomains: Array.from(activeDomains),
    });
  }

  function restoreState(ctx: ExtensionContext) {
    const branchEntries = ctx.sessionManager.getBranch();
    for (const entry of branchEntries) {
      if (entry.type === "custom" && entry.customType === "pibrarian-state") {
        const data = entry.data as PibrarianState | undefined;
        if (data?.activeDomains) {
          activeDomains = new Set(
            data.activeDomains.filter((d: string) => domains.has(d as DomainName)),
          );
        }
      }
    }
  }

  function applyActivation() {
    const allToolNames = pi.getAllTools().map((t) => t.name);
    const pibrarianToolNames = getAllDomainToolNames(domains);

    // Collect tool names for active domains
    const enabledTools = new Set<string>();

    // Keep non-pibrarian tools as-is
    for (const name of allToolNames) {
      if (!pibrarianToolNames.includes(name)) {
        enabledTools.add(name);
      }
    }

    // Add tools for active domains
    for (const domainName of activeDomains) {
      for (const toolName of getDomainToolNames(domains, domainName)) {
        enabledTools.add(toolName);
      }
    }

    pi.setActiveTools(Array.from(enabledTools));
  }

  function activateDomain(domainName: DomainName) {
    if (domains.has(domainName)) {
      activeDomains.add(domainName);
      applyActivation();
      persistState();
      return true;
    }
    return false;
  }

  function deactivateDomain(domainName: DomainName) {
    activeDomains.delete(domainName);
    applyActivation();
    persistState();
  }

  // --- Session lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    // Resolve config from pi model defaults
    const model = ctx.model;
    config = loadConfig(
      model?.baseUrl ?? "http://localhost:8080/v1",
      model?.id ?? "qwen3.6-27B",
    );

    // Build and register all domain tools
    domains = buildDomains(config);

    for (const domain of domains.values()) {
      for (const tool of domain.tools) {
        pi.registerTool(tool);
      }
    }

    // Restore activation state
    restoreState(ctx);
    applyActivation();

    ctx.ui.notify(`pibrarian loaded: ${domains.size} domains, ${activeDomains.size} active`, "info");
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreState(ctx);
    applyActivation();
  });

  // --- Commands ---

  pi.registerCommand("pibrarian-activate", {
    description: "Activate pibrarian domain tools: /pibrarian-activate <domain|all>",
    getArgumentCompletions: (prefix: string) => {
      const domains = ["books", "comics", "media", "all"];
      const items = domains
        .filter((d) => d.startsWith(prefix))
        .map((d) => ({ value: d, label: d }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const target = args.trim().toLowerCase();

      if (target === "all") {
        for (const domainName of domains.keys()) {
          activateDomain(domainName);
        }
        ctx.ui.notify(`pibrarian: all domains activated`, "info");
      } else if (domains.has(target as DomainName)) {
        activateDomain(target as DomainName);
        ctx.ui.notify(`pibrarian: ${target} domain activated`, "info");
      } else {
        const available = Array.from(domains.keys()).join(", ");
        ctx.ui.notify(`pibrarian: unknown domain "${target}". Available: ${available}`, "warning");
      }
    },
  });

  pi.registerCommand("pibrarian-deactivate", {
    description: "Deactivate pibrarian domain tools: /pibrarian-deactivate <domain|all>",
    getArgumentCompletions: (prefix: string) => {
      const domains = ["books", "comics", "media", "all"];
      const items = domains
        .filter((d) => d.startsWith(prefix))
        .map((d) => ({ value: d, label: d }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const target = args.trim().toLowerCase();

      if (target === "all") {
        for (const domainName of domains.keys()) {
          deactivateDomain(domainName);
        }
        ctx.ui.notify(`pibrarian: all domains deactivated`, "info");
      } else if (domains.has(target as DomainName)) {
        deactivateDomain(target as DomainName);
        ctx.ui.notify(`pibrarian: ${target} domain deactivated`, "info");
      } else {
        const available = Array.from(domains.keys()).join(", ");
        ctx.ui.notify(`pibrarian: unknown domain "${target}". Available: ${available}`, "warning");
      }
    },
  });

  pi.registerCommand("pibrarian-jellyfin-login", {
    description: "Authenticate with Jellyfin: /pibrarian-jellyfin-login <username> <password>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length !== 2) {
        ctx.ui.notify("Usage: /pibrarian-jellyfin-login <username> <password>", "warning");
        return;
      }
      const [username, password] = parts;
      const baseUrl = config.jellyfin.baseUrl;

      try {
        // Step 1: Get auth header
        const authRes = await fetch(`${baseUrl}/Users/authenticatebyname`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ Username: username, Pw: password }),
        });

        if (!authRes.ok) {
          ctx.ui.notify(`Jellyfin auth failed: ${authRes.status}`, "error");
          return;
        }

        const authData = await authRes.json();
        const userId = authData.User?.Id;
        const token = authData.User?.ServerId || authData.AccessToken;

        if (!userId || !token) {
          ctx.ui.notify("Jellyfin auth succeeded but no userId/token returned", "error");
          return;
        }

        // Save auth to config
        saveJellyfinAuth(userId, token);

        // Update in-memory config
        config.jellyfin.userId = userId;
        config.jellyfin.token = token;

        ctx.ui.notify(`Jellyfin authenticated as ${authData.User?.Name || username}`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Jellyfin login error: ${err.message}`, "error");
      }
    },
  });

  pi.registerCommand("pibrarian-status", {
    description: "Show pibrarian domain status",
    handler: async (_args, ctx) => {
      const lines = ["pibrarian domains:"];
      for (const [name, info] of domains) {
        const status = activeDomains.has(name) ? "active" : "inactive";
        lines.push(`  ${name}: ${status} — ${info.description}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
