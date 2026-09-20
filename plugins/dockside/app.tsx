// bb-plugin-dockside — a project-first replacement for bb's sidebar thread
// list. Root threads keep a stable position and expand their child agents in
// place, so activity changes state without moving the user's navigation.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ThreadInbox } from "@/components/inbox/thread-inbox";
import { ParentChip } from "@/components/inbox/parent-chip";
import { DocksideSettingsSection } from "@/components/settings/dockside-settings";
import { MobileNavigation } from "@/components/mobile/navigation";
import { mountSettingsColorFields } from "@/lib/settings-color-fields";

export default definePluginApp((app) => {
  app.composer.customize({
    id: "mobile-navigation",
    scopes: ["thread"],
    banners: [{ id: "navigation", chrome: "bare", component: MobileNavigation }],
  });

  // The custom palette fields are drawn by the host, whose setting descriptors
  // stop at plain strings. Decorating them in place gives each one a live
  // swatch and a color picker without moving the values out of bb's settings.
  app.contentScripts.register({
    id: "settings-color-fields",
    mount: ({ pluginId, signal }) => mountSettingsColorFields(signal, pluginId),
  });

  app.slots.settingsSection({
    id: "appearance",
    title: "Appearance & behavior",
    description: "Preview the effective Dockside palette and layout settings.",
    component: DocksideSettingsSection,
  });

  app.slots.experimental_threadList({
    id: "inbox",
    title: "Dockside (projects)",
    description:
      "Stable project groups with expandable root threads and inline agents.",
    component: ThreadInbox,
  });

  // A child remains nested in the sidebar, and this is the direct route back
  // to its root while the user is focused in the thread itself.
  app.slots.experimental_threadHeaderAction({
    id: "parent",
    title: "Parent thread",
    component: ParentChip,
  });
});
