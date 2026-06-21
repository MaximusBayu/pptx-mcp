import { listPublicTemplates } from "@/lib/templates";
import { GalleryGrid } from "./GalleryGrid";

export const dynamic = "force-dynamic";

export default async function Gallery() {
  const templates = await listPublicTemplates();
  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold mb-6">Public gallery</h1>
      <GalleryGrid templates={templates.map((t) => ({ id: t.id, name: t.name, description: t.description }))} />
    </div>
  );
}
