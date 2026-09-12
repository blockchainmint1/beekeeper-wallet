import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BookUser, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { QrScanButton, parseWalletUri } from "@/components/wallet/QrScanButton";
import {
  CHAIN_LABELS,
  type Contact,
  type ContactChain,
  addContact,
  deleteContact,
  listContacts,
  updateContact,
  validateAddress,
} from "@/lib/address-book";

export const Route = createFileRoute("/wallet/contacts")({
  head: () => ({ meta: [{ title: "Address Book — BeeKeeper Wallet" }] }),
  component: ContactsPage,
});

const CHAIN_OPTIONS: ContactChain[] = ["txc", "isk", "btc", "ltc", "doge", "eth", "base", "bsc", "zcu"];

function ContactsPage() {
  const [items, setItems] = useState<Contact[]>([]);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [adding, setAdding] = useState(false);

  function refresh() {
    setItems(listContacts().sort((a, b) => a.name.localeCompare(b.name)));
  }

  useEffect(() => {
    refresh();
    const h = () => refresh();
    window.addEventListener("hme:contacts-changed", h);
    return () => window.removeEventListener("hme:contacts-changed", h);
  }, []);

  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <Link to="/wallet" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back
      </Link>
      <div className="mt-3 flex items-center justify-between">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BookUser className="h-6 w-6" /> Address Book
        </h1>
        {!adding && !editing && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4 mr-1" /> Add
          </Button>
        )}
      </div>

      {(adding || editing) && (
        <ContactForm
          initial={editing ?? undefined}
          onCancel={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSaved={() => {
            setAdding(false);
            setEditing(null);
            refresh();
          }}
        />
      )}

      {items.length === 0 && !adding && (
        <Card className="mt-6">
          <CardContent className="pt-6 text-sm text-muted-foreground text-center">
            No saved contacts yet. Add one to send faster and avoid address-paste mistakes.
          </CardContent>
        </Card>
      )}

      <div className="mt-4 space-y-2">
        {items.map((c) => (
          <Card key={c.id}>
            <CardContent className="py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{c.name}</div>
                <div className="text-xs text-muted-foreground">{CHAIN_LABELS[c.chain]}</div>
                <code className="text-xs font-mono break-all text-muted-foreground">{c.address}</code>
              </div>
              <div className="flex flex-col gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setAdding(false);
                    setEditing(c);
                  }}
                  aria-label="Edit"
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    if (confirm(`Delete "${c.name}"?`)) deleteContact(c.id);
                  }}
                  aria-label="Delete"
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}

function ContactForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: Contact;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [chain, setChain] = useState<ContactChain>(initial?.chain ?? "txc");
  const [address, setAddress] = useState(initial?.address ?? "");
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    const addrErr = validateAddress(chain, address);
    if (addrErr) {
      setError(addrErr);
      return;
    }
    if (initial) {
      updateContact(initial.id, { name, chain, address });
    } else {
      addContact({ name, chain, address });
    }
    onSaved();
  }

  return (
    <Card className="mt-5">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <div>
          <CardTitle>{initial ? "Edit contact" : "New contact"}</CardTitle>
          <CardDescription>Saved locally on this device only.</CardDescription>
        </div>
        <Button variant="ghost" size="icon" onClick={onCancel} aria-label="Cancel">
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="c-name">Name</Label>
            <Input
              id="c-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Alice, Cold storage"
              className="mt-1"
              maxLength={60}
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="c-chain">Chain</Label>
            <select
              id="c-chain"
              value={chain}
              onChange={(e) => setChain(e.target.value as ContactChain)}
              className="mt-1 w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              {CHAIN_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {CHAIN_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="c-addr">Address</Label>
            <div className="mt-1 flex gap-2">
              <Input
                id="c-addr"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder={
                  chain === "txc"
                    ? "txc1..."
                    : chain === "isk"
                      ? "is..."
                      : chain === "btc"
                        ? "bc1q..."
                        : chain === "ltc"
                          ? "ltc1..."
                          : chain === "doge"
                            ? "D..."
                            : "0x..."
                }
                className="font-mono"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <QrScanButton
                onScan={(raw) => {
                  const parsed = parseWalletUri(raw);
                  setAddress(parsed.address || raw.trim());
                  setError(null);
                }}
              />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" className="flex-1">
              {initial ? "Save changes" : "Add contact"}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
