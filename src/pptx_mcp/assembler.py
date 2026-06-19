import copy

from pptx import Presentation

from .models import Template

# Namespace URI for Office Open XML relationships
_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

# Attribute name for the relationship id on <p:sldId> elements
_RID_ATTR = "{%s}id" % _REL_NS

# Reltype fragment that identifies a slide-layout relationship
_SLIDE_LAYOUT_RELTYPE_FRAGMENT = "slideLayout"


def find_shape(slide, shape_id: int):
    """Return the shape on *slide* whose shape_id matches, or raise KeyError."""
    for shape in slide.shapes:
        if shape.shape_id == shape_id:
            return shape
    raise KeyError(f"shape_id {shape_id} not found on slide")


def _duplicate_slide(prs: Presentation, src_index: int):
    """Append a copy of slide *src_index* (within the same package) and return it.

    Deep-copies every shape element from the source slide's spTree into the new
    slide.  Relationship ids in the *source* slide part may differ from those in
    the *destination* part, so this function:

    1. Copies every relationship from the source part into the dest part via
       ``Part.relate_to``, EXCEPT the slide-layout relationship (which was already
       wired when ``add_slide(layout)`` was called and must not be duplicated).
    2. Builds a complete ``old_rid -> new_rid`` map from those copies.
    3. Rewrites every ``r:embed``, ``r:link``, and ``r:id`` attribute in the
       copied XML tree using that map, so charts, hyperlinks, and images all
       resolve correctly in the destination part.
    """
    source = prs.slides[src_index]
    layout = source.slide_layout
    dest = prs.slides.add_slide(layout)

    # Remove any placeholder shapes that add_slide inserted from the layout.
    for shp in list(dest.shapes):
        shp._element.getparent().remove(shp._element)

    # Deep-copy each source shape element into the dest spTree.
    for shp in source.shapes:
        dest.shapes._spTree.append(copy.deepcopy(shp._element))

    # Copy ALL relationships from the source slide part into the dest part,
    # skipping the slide-layout rel (already established by add_slide).
    # Record old_rid -> new_rid for every copied relationship.
    old_to_new_rid: dict[str, str] = {}
    for rid, rel in source.part.rels.items():
        if _SLIDE_LAYOUT_RELTYPE_FRAGMENT in rel.reltype:
            # Already wired via add_slide(layout); copying it again would
            # create a duplicate slide-layout relationship in the dest part.
            continue
        if rel.is_external:
            new_rid = dest.part.relate_to(rel._target, rel.reltype, is_external=True)
        else:
            new_rid = dest.part.relate_to(rel._target, rel.reltype)
        old_to_new_rid[rid] = new_rid

    # Rewrite r:embed / r:link / r:id attributes in the copied XML to dest rIds.
    if old_to_new_rid:
        embed_attr = "{%s}embed" % _REL_NS
        link_attr = "{%s}link" % _REL_NS
        rid_attr = "{%s}id" % _REL_NS
        for elem in dest.shapes._spTree.iter():
            for attr in (embed_attr, link_attr, rid_attr):
                old_val = elem.get(attr)
                if old_val and old_val in old_to_new_rid:
                    elem.set(attr, old_to_new_rid[old_val])

    return dest


def assemble(order: list[int], template: Template) -> Presentation:
    """Return a Presentation whose slides are copies of the template's base slides
    at the given *source_slide_index* values (in *order*), with the original base
    slides removed.

    All shape types (text, tables, pictures) survive a save -> reopen round-trip.

    Original slide Parts (and any media they exclusively own) are fully removed
    from the package by:
      1. Capturing each original slide's rId from its <p:sldId> element.
      2. Removing the <p:sldId> element from the presentation XML (drops the
         XML reference so _rel_ref_count falls to 0).
      3. Calling prs.part.drop_rel(rId) to remove the relationship entry and
         allow the serialiser to omit the orphaned Part from the saved zip.

    Because the duplicated slides hold their own independent relationships to
    shared image/media parts, dropping the originals does not break the copies.
    """
    prs = Presentation(template.pptx_path)
    original_count = len(prs.slides)

    for src_index in order:
        _duplicate_slide(prs, src_index)

    # Collect rIds and sldId elements for the original base slides before removal.
    xml_slides = prs.slides._sldIdLst
    originals = list(xml_slides)[:original_count]

    # Capture the rId for each original before touching the XML.
    original_rids = [sid.get(_RID_ATTR) for sid in originals]

    # Remove each original slide: first drop the XML element (reduces ref-count
    # to 0), then call drop_rel so the Part is removed from the package.
    for sid, rId in zip(originals, original_rids):
        xml_slides.remove(sid)   # ref-count goes to 0
        if rId is not None:
            prs.part.drop_rel(rId)   # Part removed from package

    return prs
