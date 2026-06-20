import Link from "next/link";
import { auth, signOut } from "@/lib/auth";

// Shared chrome for every signed-in page: a top nav so navigation no longer
// depends on typing URLs. Server component — reads the session directly.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const email = session?.user?.email ?? "";

  return (
    <div className="min-h-screen">
      <header className="border-b sticky top-0 z-20 bg-white/80 backdrop-blur">
        <nav className="mx-auto max-w-6xl px-6 h-14 flex items-center gap-6 text-sm">
          <Link href="/dashboard" className="font-semibold">pptx-mcp</Link>
          <Link href="/dashboard" className="text-gray-600 hover:text-black">My templates</Link>
          <Link href="/gallery" className="text-gray-600 hover:text-black">Gallery</Link>
          <Link href="/settings/keys" className="text-gray-600 hover:text-black">API keys</Link>
          <div className="ml-auto flex items-center gap-4">
            <Link href="/templates/new"
              className="bg-black text-white px-3 py-1.5 rounded">New template</Link>
            {email && <span className="hidden sm:inline text-gray-500">{email}</span>}
            <form action={async () => { "use server"; await signOut({ redirectTo: "/login" }); }}>
              <button type="submit" className="text-gray-600 hover:text-black">Sign out</button>
            </form>
          </div>
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}
