# @sovereign-os/ui

The **Sovereign Agentic OS** design language as a small, **framework-agnostic,
vendorable** React + CSS package. Import it and a new app inherits the OS look —
the dark-luxury palette, gold-on-black chrome, the Oswald / Marcellus / Rubik
type system, and the core `.sb-*` component classes — with **no build step and no
Next.js**. It runs in a plain Vite app (or any React setup).

This mirrors how `@sovereign-os/app-sdk` is vendored: the on-disk source under
`lib/app-ui/` is the single source of truth, copied into an app repo under
`vendor/@sovereign-os/ui/` at seed time (see `lib/software/app-ui-vendor.ts`).

## Install / vendor

The package is vendored, not published. The scaffolder copies `lib/app-ui/*`
into `vendor/@sovereign-os/ui/` and adds a `file:` dependency, so the build stays
sovereign (no registry). In app code you then import it by name.

## Use

**1. Import the theme once** (a side-effect stylesheet — put it in your root):

```ts
import '@sovereign-os/ui/theme.css';
```

The theme sets CSS custom properties on `:root`, styles the `.sb-*` classes, and
pulls the brand fonts from Google Fonts (with system fallbacks, so it degrades
gracefully offline). Dark mode is opt-in: set `data-theme="dark"` on `<html>` (or
any ancestor of the content). The nav chrome stays dark in **both** themes, just
like the OS.

**2. Wrap your app in `AppShell`** — the OS sidebar + topbar, driven by *your*
nav items:

```tsx
import { AppShell, Button, Card, Section, Badge } from '@sovereign-os/ui';

export function App() {
  return (
    <AppShell
      brand="Acme App"
      brandSub="Powered by Sovereign OS"
      nav={[
        { label: 'Home', icon: '◇', href: '/', active: true },
        { label: 'Data', icon: '▤', href: '/data' },
        { label: 'Settings', icon: '⚙', onClick: () => openSettings() },
      ]}
      title="Home"
      crumb="Overview"
      topbarRight={<Button variant="ghost" size="sm">Sign out</Button>}
      sidebarFooter={<>Signed in as <strong>you@acme.com</strong></>}
    >
      <Section title="Recent">
        <Card>
          <h3>Datasets</h3>
          <div className="sb-big">128</div>
          <Badge tone="ok">Live</Badge>
        </Card>
      </Section>
    </AppShell>
  );
}
```

`nav` items take **either** `href` (renders an `<a>`) **or** `onClick` (renders a
`<button>`) — so the shell works with any router or none. `brand`, `topbarRight`,
and `sidebarFooter` are free slots.

## Primitives

| Component | Notes |
| --- | --- |
| `AppShell` | Sidebar + topbar chrome. Nav items, title, and slots via props. |
| `Button` | `variant="primary" \| "ghost"`, `size="md" \| "sm"`. |
| `Card` | Bordered panel with the gold hover accent. |
| `Badge` | `tone="default" \| "ok" \| "warn" \| "err" \| "muted"`. |
| `Input` / `Textarea` | Field with the gold focus ring. |
| `Select` | Same field styling, auto width. |
| `Table` | Bordered, scrollable wrapper + sticky gold header. Compose `<thead>/<tbody>`. |
| `Section` | Gold-eyebrow title + body. |
| `Panel` | Calm neutral bordered container. |

## Fully overridable

Every primitive forwards `className` and native props. Append your own classes,
override any token in your app's `:root` (e.g. `--sb-gold: #…`), or use the raw
`.sb-*` classes directly. Nothing is locked in.

```css
:root { --sb-gold: #b8863b; --sb-radius: 8px; }
```
