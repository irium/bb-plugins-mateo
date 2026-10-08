import { useId, useState } from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  type PluginSidebarThread,
} from "@bb/plugin-sdk/app";
import { Icon, type IconName } from "@/components/ui/icon";
import { RowContextMenu } from "@/components/inbox/row-context-menu";
import { StatusGlyph } from "@/components/inbox/status-glyph";
import { threadStatus } from "@/components/inbox/status-slot";
import { cn } from "@/lib/utils";
import { threadDisplayTitle } from "@/lib/inbox";
import { relativeTimeLabel } from "@/lib/relative-time";
import {
  readCollapsedTurnSections,
  writeCollapsedTurnSections,
  type TurnEntry,
  type TurnSectionId,
  type TurnSectionLists,
} from "@/lib/turn-sections";

const SECTIONS: ReadonlyArray<{
  id: TurnSectionId;
  title: string;
  icon: IconName;
  empty: string;
}> = [
  { id: "inbox", title: "Inbox", icon: "Inbox", empty: "Nothing finished yet" },
  { id: "working", title: "Working", icon: "Loading", empty: "Nothing running" },
];

/**
 * Inbox and Working, drawn above the Workspaces header. Each header folds its
 * list, and the fold survives a reload. Rows open their thread the way the
 * workspace rows do and carry the same context menu.
 */
export function TurnSections({
  lists,
  activeThreadId,
  onNavigate,
  now,
}: {
  lists: TurnSectionLists;
  activeThreadId: string | null;
  onNavigate: () => void;
  now: number;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsedTurnSections);
  const toggle = (id: TurnSectionId) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    writeCollapsedTurnSections(next);
    setCollapsed(next);
  };

  return (
    <div data-dockside-turn-sections="" className="shrink-0 pb-1">
      {SECTIONS.map((section) => (
        <TurnSection
          key={section.id}
          {...section}
          entries={lists[section.id]}
          collapsed={collapsed.has(section.id)}
          onToggle={() => toggle(section.id)}
          activeThreadId={activeThreadId}
          onNavigate={onNavigate}
          now={now}
        />
      ))}
      <div aria-hidden className="mx-2.5 mt-1 border-t border-sidebar-border/60" />
    </div>
  );
}

function TurnSection({
  id,
  title,
  icon,
  empty,
  entries,
  collapsed,
  onToggle,
  activeThreadId,
  onNavigate,
  now,
}: {
  id: TurnSectionId;
  title: string;
  icon: IconName;
  empty: string;
  entries: readonly TurnEntry[];
  collapsed: boolean;
  onToggle: () => void;
  activeThreadId: string | null;
  onNavigate: () => void;
  now: number;
}) {
  const listId = useId();
  return (
    <section aria-label={title} data-dockside-turn-section={id}>
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={listId}
        onClick={onToggle}
        className="flex h-7 w-full items-center gap-2 rounded-md px-2.5 text-left text-muted-foreground hover:bg-sidebar-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name={icon} className="size-3.5" aria-hidden />
        <span className="text-2xs font-semibold uppercase tracking-wider">
          {title}
        </span>
        <span className="tabular-nums text-2xs text-muted-foreground/70">
          {entries.length}
        </span>
        <Icon
          name="ChevronDown"
          className={cn(
            "ml-auto size-3 transition-transform",
            collapsed && "-rotate-90",
          )}
          aria-hidden
        />
      </button>
      {collapsed ? null : entries.length === 0 ? (
        <p id={listId} className="m-0 px-2.5 pb-1 text-2xs text-muted-foreground/60">
          {empty}
        </p>
      ) : (
        <ul id={listId} className="m-0 flex flex-col gap-0.5 p-0 px-1">
          {entries.map((entry) => (
            <TurnRow
              key={entry.thread.id}
              entry={entry}
              isActive={entry.thread.id === activeThreadId}
              onNavigate={onNavigate}
              now={now}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function TurnRow({
  entry,
  isActive,
  onNavigate,
  now,
}: {
  entry: TurnEntry;
  isActive: boolean;
  onNavigate: () => void;
  now: number;
}) {
  const actions = useSidebarThreadActions();
  const { thread } = entry;
  const title = threadDisplayTitle(thread);
  return (
    <RowContextMenu thread={thread}>
      <li className="list-none">
        <a
          href="#"
          aria-label={title}
          aria-current={isActive ? "page" : undefined}
          data-dockside-turn-row={thread.id}
          onClick={(event) => {
            event.preventDefault();
            actions.open(thread.id, { split: event.metaKey || event.ctrlKey });
            onNavigate();
          }}
          className={cn(
            "flex h-7 items-center gap-2 rounded-md px-1.5 text-xs no-underline",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            isActive
              ? "bg-sidebar-accent text-foreground"
              : thread.isUnread
                ? "font-semibold text-foreground hover:bg-sidebar-accent/60"
                : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
          )}
        >
          <TurnGlyph thread={thread} />
          <span title={title} className="min-w-0 flex-1 truncate">
            {title}
          </span>
          <span className="shrink-0 font-normal tabular-nums text-2xs text-muted-foreground/70">
            {relativeTimeLabel(entry.at, now)}
          </span>
        </a>
      </li>
    </RowContextMenu>
  );
}

function TurnGlyph({ thread }: { thread: PluginSidebarThread }) {
  const status = threadStatus(thread);
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center">
      {status === null ? (
        <span
          aria-hidden
          className="size-1.5 rounded-full opacity-50"
          style={{
            backgroundColor:
              "var(--dockside-status-inactive, var(--muted-foreground))",
          }}
        />
      ) : (
        <StatusGlyph indicator={status.indicator} label={status.label} />
      )}
    </span>
  );
}
