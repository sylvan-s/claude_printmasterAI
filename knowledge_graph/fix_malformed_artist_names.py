"""
PrintMasterAI — Artist nodes whose name is not an artist's name.
Version: ARTIST-NAME-REPAIR-1.0

    python3 fix_malformed_artist_names.py plan  --out malformed_artist_names_plan.csv
    python3 fix_malformed_artist_names.py apply --plan malformed_artist_names_plan.csv

Found 2026-09-17 while building the A0793 evidence cards: the Chagall node was called
"Marc Chagall . Charles Sorlier". A sweep for the same shapes found 135 nodes, and they are not
one defect:

  punctuation     "Edmé Bouchardon,"  "Sebastian Münster."  "Anton Boys, Circle of."
  dates / titles  "Stanley Anderson British 1884-1966- \"Windswept Corn\""  "Marc Chagall. Quai de la Tournelle"
  wrappers        "RTO Anna Pugh"  "WITHDRAWN. Arnaldo Pomodoro"  "AMENDMENT: ... Charles Maurice Detmold"
  lot headers     "The following lots 66-71 are from the Curwen Studio Archive"
  several hands   "Andy Warhol (American 1928-1987) &"  (the second artist was cut off at the ampersand)
  not an artist   "Eleven Prints by Eleven Printmakers."  "Verve: An Artistic and Literary Quarterly ..."

WHY EVERY DECISION IS WRITTEN OUT. Regex finds these nodes; it cannot say who made the work. The
catalogue identity rule (no fuzzy matching — two corruption incidents) applies here too. Each
decision below rests on the house's own words: for Roseberys, the lot description fetched from
the lot page on 2026-09-17 (the wrapper text was glued onto the artist field by the ingest, and
the real artist follows it in the same description); for other houses, the name inside the
malformed string itself. Targets are matched to existing nodes by EXACT name or alternateName.

WHAT A FIX DOES, PER WORK. The work's CREATED edge moves to the target artist(s); each source
record's ATTRIBUTED_TO moves with it, keeping its qualifier unless the plan names one (lot text
"reproduction" -> after, "Circle of" -> circle_of). When every work on a node goes to ONE artist
who has no node yet, the node is renamed instead, so its FROM_REGION and PRICE_NEIGHBOUR edges and
dates survive. A node emptied by re-pointing is deleted.

THIS IS NOT merge_artists.MERGE_PAIR. That primitive writes the absorbed name into the survivor's
alternateNames; "RTO Anna Pugh" is not a name Anna Pugh goes by. The one exception is a pure
spelling variant that collides with an existing node — none in this set.

LEFT ALONE, on purpose: legitimate names that merely look odd ("R.G. & A.W. Reeve", a printing
firm; "Monogrammist G.N."; "Marie-Antoinette Fournier Des Corats Née ..."), records that are not
artworks ("Lot 106 Administration Charge", "WITHDRAWN" with no description), and nodes whose works
have no recoverable maker ("Old Master Print from Chatsworth.-", "Portfolio", whose 16 works mix
single-artist and multi-artist portfolios and need a person to read them).
"""

import argparse
import csv
import datetime
import json
import os
import sys

from dotenv import load_dotenv

load_dotenv(os.path.expanduser("~/PycharmProjects/claude_printmasterAI/.env"))
from neo4j import GraphDatabase  # noqa: E402

VA = "Various Artists"

# Node name -> list of (target, qualifier or None). None keeps each record's own qualifier.
BY_NODE = {
    # punctuation, dates, titles glued to one artist
    "Edmé Bouchardon,": [("Edmé Bouchardon", None)],
    "Crispijn van den Broeck,": [("Crispijn van den Broeck", None)],
    "Juan Fernández Navarrete, called 'El Mudo',": [("Juan Fernández Navarrete", None)],
    "Gaspare Diziani,": [("Gaspare Diziani", None)],
    "Hubert Robert,": [("Hubert Robert", None)],
    "Antonio da Trenta,": [("Antonio da Trenta", None)],
    "Sebastian Münster.": [("Sebastian Münster", None)],
    "Filippo Morghen, da Giuseppe Zocchi.": [("Filippo Morghen", None)],
    "Luca Giordano, Manner of.": [("Luca Giordano", "manner_of")],
    "Anton Boys, Circle of.": [("Anton Boys", "circle_of")],
    "Marc Chagall. Quai de la Tournelle": [("Marc Chagall", None)],
    "Arnaud Desjardin. The Everyday Press": [("Arnaud Desjardin", None)],
    "Reinier Nooms (called Zeeman) (1623-1664)": [("Reinier Nooms", None)],
    "Johannes Wiericx (after Maarten de Vos) St Michael Trampling Satan": [("Johannes Wiericx", None)],
    "Jaune Quick-to-See Smith, Enrolled Salish": [("Jaune Quick-to-See Smith", None)],
    "Andrew Power [Sybil Andrews, 1898–1992 and Cyril Power, 1872–1951]": [("Andrew Power", None)],
    "International Local (Sarah Charlesworth; Joseph Kosuth; Anthony McCall)": [("International Local", None)],
    "born 1945; Mel Ramsden, born 1944) Art & Language (Michael Baldwin": [("Art & Language", None)],
    "Stanley Anderson British 1884-1966- \"Windswept Corn\"": [("Stanley Anderson RA RE", None)],
    "David Shrigley British b.1968- \"It's OK\" 2017; digital pigment print in colours": [("David Shrigley", None)],
    "Laurence Stephen Lowry British 1887-1976- \"His Family\"; reproduction printed in colours": [("Laurence Stephen Lowry", "after")],
    "Laurence Stephen Lowry British 1887-1976- \"Two Brothers\"; reproduction printed in colours": [("Laurence Stephen Lowry", "after")],
    "Laurence Stephen Lowry British 1887-1976- \"Berwick-upon-Tweed\"; reproduction printed in colours": [("Laurence Stephen Lowry", "after")],
    "Pablo Picasso 1881-1973- Tête de Faune; lithograph printed in colours on Richard de Bas": [("Pablo Picasso", "after")],
    "Claude Monet . & George-William Thornley": [("Claude Monet", "after")],   # Thornley's lithographs after Monet
    "Rembrandt van Rijn and others.": [("Rembrandt van Rijn", None)],          # album of five Rembrandt etchings
    # Forum's Italian descriptions pasted whole into the artist field
    "Antonio Tempesta Due tavole": [("Antonio Tempesta", None)],
    "Erhard Schön Ritratto": [("Erhard Schön", None)],
    "Hendrik Goltzius Marte": [("Hendrick Goltzius", None)],
    "Francesco Barbazza Disegno": [("Francesco Barbazza", None)],
    "Da Jan van der Straet": [("Jan Van Der Straet", "after")],
    "Da Rembrandt van Rijn": [("Rembrandt van Rijn", "after")],
    "Anonimo. Navi in tempesta, [probabilmente XVIII secolo].": [("Anon", None)],
    "Anonimo. Nuovo Lunario per l'anno 1825. Torino, Stamperia Luigi Soffietti, [1825].": [("Anon", None)],
    "Anon.": [("Anon", None)],
    "Scuola italiana.": [("Italian School", None)],
    # Roseberys wrappers whose every lot names one artist
    "RTO Anna Pugh": [("Anna Pugh", None)],
    "RTO Daniel Mackenzie": [("Daniel Mackenzie", None)],
    "RTO Adam B Marshall": [("Adam B Marshall", None)],
    "RTO Dolf Reiser": [("Dolf Reiser", None)],
    "RTO Michael Carlo": [("Michael Carlo", None)],
    "RTO Sophie Macpherson": [("Sophie Macpherson", None)],
    "RTO Bernard Munch": [("Bernard Munch", None)],
    "RTO TO BE AUTHENTICATED": [("Keith Haring", "attributed_to")],
    "WITHDRAWN. Arnaldo Pomodoro": [("Arnaldo Pomodoro", None)],
    "Lots 97-112 from a private collection comprising of etchings printed and published by 2RC Edizioni d'Arte": [("Arnaldo Pomodoro", None)],
    "AMENDMENT: NOT PRINTED IN COLOURSCharles Maurice Detmold": [("Charles Maurice Detmold", None)],
    "PLEASE SPLIT INTO THREE LOTS OF £100-150 RESERVE £90 EACHThree Copies of Derrière le Miroir": [("Saul Steinberg", None)],
    "Donated to Royal Society of Sculptors:": [("Gerald Laing", None)],
    "Lots 209-219 are from the archive of Gresham Studio": [("Alan Davie", None)],
    "Lots 209-219 from archive of Gresham Studio": [("Alan Davie", None)],
    "The following lots 66-71 are from the Curwen Studio Archive": [("Prunella Clough", None)],
    "following lots 66-71 from Curwen Studio Archive": [("Prunella Clough", None)],
    "following lots 123-146 from Curwen Studio Archive": [("Mark Hearld", None)],
    "following lots 140-154 from Curwen Studio Archive": [("Mark Hearld", None)],
    "following three lots 4-6 from art collection at former St Gabriel's College": [("Leon Underwood", None)],
    "Lots 252-274 have following:": [("Jean Camberoque", None)],
    "following lots 249-253 were published to coincide with Tate's major Constable exhibition in 1976. Bernard Jacobson commissioned 19 artists to contribute a print to portfolio. Several of selected artists chose to respond directly to individual works (or series of works) by Constable in V&A collection.": [("Robyn Denny", None)],
    "following lots 200-223 from a Private Collection and by French photographer Andre Villers": [("André Villers", None)],
    "following lots 233-237 by photographer André Gomès. Provenance: Drouot Montaigne Auction": [("André Gomès", None)],
    "following lots 247-250 by Hungarian/French photographer Gyula Halasz Brassai": [("Brassaï", None)],
    "-": [("Salvador Dalí", None)],
    "AMENDMENT: Please note this is a Lithograph printed in olive green with later hand-colouring and graphite rather than lithograph printed in colours as described.": [("Henri de Toulouse-Lautrec", None)],
    "AMENDMENT: Please note this print is numbered 3/20 and not 7/20 as described": [("Kim Lim", None)],
    "AMENDMENT: measurement should read: sheet 69.5 x 69.5cm": [("Nick Smith", None)],
    "AMENDMENT: work is unframed": [("Yayoi Kusama", None)],
    "AMENDMENT: signature is in plate": [("John Piper", None)],
    "AMENDMENT: Please note: this limited edition of 125 unique variations of a single image is individually hand painted by artist in his Brighton studio.": [("David Shrigley", None)],
    "AMENDMENT: This is an unique work": [("Susan Hiller", None)],
    "AMENDMENT: This is a black and white photographic print": [("Alberto Diaz Gutierrez Korda", None)],
    "AMENDMENT: titled of this work is Untitled (Capitol Detail).": [("Robert Longo", None)],
    "AMENDMENT: This work is in brown colour way": [("KAWS", None)],
    "AMENDMENT: this work is a lithograph": [("Prunella Clough", None)],
    "AMENDMENT: Please note this photograph was printed later c.1980": [("Alfred Stieglitz", None)],
    "AMENDMENT Please note image for this Lot should be with a blue background.": [("Eelus (Lee Pennington)", None)],
    "Amendment - this lot is unframed": [("Max Ernst", None)],
    "Amendment - this lot was not purchased from a New York gallery but acquired from artist through charity Fashion Acts": [("Linda McCartney", None)],
    "AMENDMENT Please note VAT does not apply to hammer price on this Lot.": [("William Turnbull", None)],
    "Amendment - please note this lot has no edition number": [("Robert MacBryde", None)],
    "Amendment - please note this work is numbered 45/250 and signed and dated 74 on reverse in pencil": [("Andy Warhol", None)],
    "AMENDMENT : Please note": [("Douglas Gordon", None)],
    "AMENDMENT : Please note this work is called A streetcar named desire #2 not as stated": [("David Yarrow", None)],
    "Amendment: Please note that title of this work is 'Folded Man'": [("Peter Schuyff", None)],
    "AMENDMENT: Please note dimensions of sheet 150": [("David LaChapelle", None)],
    "AMENDMENT: Please note that VAT will be charged on hammer price for this lot.": [("Maria Drea", None)],
    "Please note artist name & title should read: Ivan Picelji": [("Ivan Picelj", None), ("Victor Vasarely", None)],
    # several named hands on one work
    "Howard Hodgkin (British 1932-2017) & Dame Rachel Whiteread": [("Howard Hodgkin", None), ("Rachel Whiteread", None)],
    "János Miklós Vaszary (Hungarian 1867-1939) &": [("János Miklós Vaszary", None), ("Istvan Prihoda", None)],
    "Stephen Spender (British 1909-1985)": [("Stephen Spender", None), ("David Hockney", None)],
    "Basil Bunting (British 1900-1985) &": [("Basil Bunting", None), ("Robert Perkins", None)],
    "Walasse Ting (Chinese/American 1928-2010) &": [("Walasse Ting", None), ("Sam Francis", None), (VA, None)],
    "Ginny Manning / Christine Keeler (British 1942-2017)": [("Ginny Manning", None)],
    "Maurizo Cattelan and Pierpaolo Ferrari for Selleti wears Toiletpaper": [("Maurizio Cattelan", None), ("Pierpaolo Ferrari", None)],
    "Roy Lichtenstein; Andy Warhol; Keith Haring; Jean-Michel Basquiat; Yoko Ono": [("Roy Lichtenstein", None), ("Andy Warhol", None), ("Keith Haring", None), ("Jean-Michel Basquiat", None), ("Yoko Ono", None)],
    # multi-artist publications: the graph's existing model is Various Artists
    "Tauba Auerbach, André Cadere, K8 Hardy, Sam Pulitzer, and Peter Saville": [(VA, None)],
    "Picasso and others.- Valéry and others. La Nouvelle Revue Française, 13 vol., portrait frontispieces": [(VA, None)],
    "Verve: An Artistic and Literary Quarterly Vol.1, Nos.2-3; Vol.2 Nos.5-6, 8; Vol.3, Nos.31-32, Vol.4, Nos.14-16": [(VA, None)],
    "Verve: An Artistic and Literary Quarterly Vol.1 Nos.1,4; Vol.4 Nos.13, 21-22": [(VA, None)],
    "Henry Richard Greville, 3rd Earl of Warwick, and others.": [(VA, None)],
    "Benjamin West, and others.": [(VA, None)],
    "Decorative Topographical and Caricature Prints including Maps": [(VA, None)],
    "Editado por el Ministerio de Instruccion Publica y Sanidad de la Republica Espanola-": [(VA, None)],
    "SEMA-": [(VA, None)],
    "\"Mythos/Re-Objects\"-": [(VA, None)],
    "Ruby Editions-": [(VA, None)],
    "Various Artists- Curwen 50th Anniversary Portfolio; published by Curwen Studio": [(VA, None)],
    "A collection of approximately one-hundred Curwen Press End Papers": [(VA, None)],
    "A collection of approximately thirty-five Curwen Press End Papers": [(VA, None)],
    "A collection of approximately thirty Curwen Press End Papers": [(VA, None)],
    "Eleven Prints by Eleven Printmakers.": [(VA, None)],
    "Sonettes et Eau-Fortes.": [(VA, None)],
    "Eaux-Fortes Modernes.": [(VA, None)],
    "Paroles Peintes II.": [(VA, None)],
    "Ausstellung von Künstlergruppe Brücke.": [(VA, None)],
    "Katalog Ausstellung Brücke.": [(VA, None)],
    "Exposition de la \"Dèpêche\" de Toulouse.": [(VA, None)],
    "Bicentennial Pageant of George Washington.": [(VA, None)],
    "Regards sur Paris.": [(VA, None)],
    "Estampes by Robert Rey.": [(VA, None)],
    "Three prints.": [(VA, None)],
    "Two color etchings.": [(VA, None)],
}

# Roseberys wrapper nodes holding lots by DIFFERENT artists: decided per lot id (the listing
# URL's trailing number), from each lot's own description.
BY_LOT = {
    # Property of an Urban Art Collector
    "517416": [("Mark Perronet", None)], "517417": [("Pure Evil (Charles Uzzell Edwards)", None)],
    "517418": [("Daisy Garn", None)], "517419": [("Jimmy Cauty", None)], "517420": [("Jimmy Cauty", None)],
    "517421": [("Jimmy Cauty", None)], "517422": [("Jamie Reid", None)], "523906": [("Jamie Reid", None)],
    "517423": [("Joe Webb", None)], "517426": [("Ben Eine", None)], "517427": [("Ben Eine", None)],
    "517428": [("Banksy", None)], "517430": [("CEPT", None)], "517432": [("Rugman", None)],
    "517433": [("Ben Allen", None)],
    # PROPERTY FROM THE COLLECTION OF THE LATE CLODAGH WADDINGTON
    "502567": [("Michael Craig-Martin", None)], "506472": [("Michael Craig-Martin", None)],
    "502568": [("Joe Tilson", None)], "502569": [("Antoni Tàpies", None)], "502570": [("Antoni Tàpies", None)],
    "502571": [("Ian Davenport", None)], "502573": [("Eduardo Paolozzi", None)],
    "502576": [("Mimmo Paladino", None)], "506474": [("Mimmo Paladino", None)],
    # Please note
    "573786": [("Antony Micallef", None)], "574056": [("Grayson Perry", None)],
    # Andy Warhol (American 1928-1987) &
    "586824": [("Andy Warhol", None), ("Richard Bernstein", None)],
    "577740": [("Andy Warhol", None), ("Richard Bernstein", None)],
    "586825": [("Andy Warhol", None), ("Cecil Beaton", None)],
    "590180": [("Andy Warhol", None), ("Cecil Beaton", None)],
    "596274": [("Andy Warhol", None), ("LeRoy Neiman", None)],
    "599305": [("Andy Warhol", None), ("LeRoy Neiman", None)],
    # Amendment: Please note following provenance ... (lots 131-132)
    "556990": [("William Turnbull", None)], "556991": [("William Turnbull", None)],
}

# Nodes that hold lots by different artists; their works are decided per lot in BY_LOT.
PER_LOT_NODES = ["Property of an Urban Art Collector", "PROPERTY FROM COLLECTION OF LATE CLODAGH WADDINGTON",
                 "Please note", "Andy Warhol (American 1928-1987) &",
                 "Amendment: Please note following provenance"]

PLAN_QUERY = """
MATCH (a:Artist)-[:CREATED]->(w:ConceptualWork) WHERE a.name IN $names
OPTIONAL MATCH (w)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(:Impression)<-[:DOCUMENTS]-(s:SourceRecord)-[:ATTRIBUTED_TO]->(a)
RETURN a.name AS node, w.id AS workId, w.name AS work,
       collect(DISTINCT s.listingUrl) AS urls, collect(DISTINCT s.id) AS sids
"""
EXISTS = """
MATCH (a:Artist) WHERE a.name = $n OR $n IN coalesce(a.alternateNames, [])
RETURN a.name AS name
"""


def connect():
    uri, user, pw = (os.getenv(k) for k in ("NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD"))
    if not all([uri, user, pw]):
        sys.exit("NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD must be set")
    return GraphDatabase.driver(uri, auth=(user, pw))


def resolve(sess, name, cache, malformed=()):
    """Exact name or alternateName. Two hits is a refusal, never a pick. A malformed node is
    never its own target: "Luca Giordano, Manner of." lists "Luca Giordano" among its own
    alternateNames, and resolving to it would re-point its works onto itself."""
    if name not in cache:
        hits = sorted({r["name"] for r in sess.run(EXISTS, n=name)} - set(malformed))
        if len(hits) > 1:
            raise RuntimeError(f"target {name!r} matches several nodes: {hits}")
        cache[name] = hits[0] if hits else None
    return cache[name]


def exact_names(sess, keys):
    """Plan keys are the malformed names as read in the survey, some cut short for the page.
    Each is pinned to ONE exact node name: the identical name if it exists, else the single
    name it prefixes. Zero or several is reported, never guessed."""
    names = [r["n"] for r in sess.run("MATCH (a:Artist) RETURN a.name AS n")]
    pinned, problems = {}, []
    for k in keys:
        if k in names:
            pinned[k] = k
            continue
        hits = [n for n in names if n.startswith(k)]
        if len(hits) == 1:
            pinned[k] = hits[0]
        else:
            problems.append((k, len(hits)))
    return pinned, problems


def cmd_plan(args):
    drv = connect()
    rows, cache = [], {}
    with drv.session(database=os.getenv("NEO4J_DATABASE") or "neo4j") as s:
        pinned, problems = exact_names(s, list(BY_NODE) + PER_LOT_NODES)
        decision = {pinned[k]: v for k, v in BY_NODE.items() if k in pinned}
        found = [dict(r) for r in s.run(PLAN_QUERY, names=sorted(set(pinned.values())))]
        missing = problems
        for f in found:
            lots = [u.rsplit("-", 1)[-1] for u in f["urls"] if u]
            per_lot = [BY_LOT[l] for l in lots if l in BY_LOT]
            targets = per_lot[0] if per_lot else decision.get(f["node"])
            if not targets:
                rows.append({**f, "urls": " ".join(f["urls"]), "sids": " ".join(f["sids"]),
                             "targets": "", "action": "leave", "note": "no decision recorded"})
                continue
            spec = []
            for name, q in targets:
                existing = resolve(s, name, cache, malformed=set(pinned.values()))
                spec.append(f"{existing or name}|{q or ''}|{'existing' if existing else 'new'}")
            rows.append({"node": f["node"], "workId": f["workId"], "work": f["work"],
                         "urls": " ".join(f["urls"]), "sids": " ".join(f["sids"]),
                         "targets": "; ".join(spec), "action": "repoint", "note": ""})
    # A node whose every work goes to the SAME single NEW artist, keeping qualifiers, is renamed.
    by_node = {}
    for r in rows:
        by_node.setdefault(r["node"], []).append(r)
    for node, rs in by_node.items():
        specs = {r["targets"] for r in rs}
        if len(specs) == 1 and rs[0]["action"] == "repoint":
            parts = rs[0]["targets"].split("; ")
            name, q, kind = parts[0].split("|")
            if len(parts) == 1 and kind == "new" and not q:
                for r in rs:
                    r["action"] = "rename"
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["action", "node", "targets", "workId", "work", "sids", "urls", "note"])
        w.writeheader()
        w.writerows(sorted(rows, key=lambda r: (r["action"], r["node"])))
    counts = {}
    for r in rows:
        counts[r["action"]] = counts.get(r["action"], 0) + 1
    print(f"{len(rows)} works on {len(by_node)} nodes: {counts}")
    if missing:
        print(f"{len(missing)} planned node names not pinned to exactly one node (key, hits): {missing}")
    print(f"wrote {args.out}; nothing written to the graph")


SNAPSHOT = """
MATCH (a:Artist) WHERE a.name IN $names
OPTIONAL MATCH (a)-[r]-(x)
RETURN elementId(a) AS id, properties(a) AS props,
       collect({type: type(r), out: startNode(r) = a, other: elementId(x),
                otherLabel: head(labels(x)), otherKey: coalesce(x.id, x.name), props: properties(r)}) AS rels
"""
ENSURE = """
MERGE (t:Artist {name: $name})
ON CREATE SET t.createdBy = 'ARTIST-NAME-REPAIR-1.0', t.createdAt = datetime(), t.createdFrom = $node
RETURN t.name AS name
"""
REPOINT_WORK = """
MATCH (junk:Artist {name: $node})-[old:CREATED]->(w:ConceptualWork {id: $workId})
MATCH (t:Artist {name: $target})
MERGE (t)-[:CREATED]->(w)
WITH junk, w, t
OPTIONAL MATCH (w)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(:Impression)<-[:DOCUMENTS]-(src:SourceRecord)-[att:ATTRIBUTED_TO]->(junk)
FOREACH (x IN CASE WHEN att IS NULL THEN [] ELSE [src] END |
    MERGE (x)-[n:ATTRIBUTED_TO]->(t)
    ON CREATE SET n.qualifier = coalesce($q, att.qualifier, 'direct'), n.repairedBy = 'ARTIST-NAME-REPAIR-1.0'
    ON MATCH SET n.qualifier = coalesce($q, n.qualifier, att.qualifier, 'direct'))
RETURN count(*) AS n
"""
DROP_OLD = """
MATCH (junk:Artist {name: $node})-[old:CREATED]->(w:ConceptualWork {id: $workId}) DELETE old
WITH junk, w
OPTIONAL MATCH (w)-[:PRINTED_AS]->(:EditionRun)-[:INCLUDES]->(:Impression)<-[:DOCUMENTS]-(src:SourceRecord)-[att:ATTRIBUTED_TO]->(junk)
DELETE att
RETURN count(*) AS n
"""
RENAME = """
MATCH (a:Artist {name: $node})
SET a.nameBeforeRepair = a.name, a.name = $target, a.nameRepairedAt = datetime(),
    a.nameRepair = 'ARTIST-NAME-REPAIR-1.0'
RETURN a.name AS name
"""
DELETE_EMPTY = """
MATCH (junk:Artist {name: $node})
WHERE NOT (junk)-[:CREATED]->() AND NOT (junk)-[:MADE_MATRIX]->() AND NOT ()-[:CATALOGUES]->(junk)
  AND NOT ()-[:ATTRIBUTED_TO]->(junk)
DETACH DELETE junk RETURN count(*) AS n
"""


def cmd_apply(args):
    rows = list(csv.DictReader(open(args.plan, encoding="utf-8")))
    todo = [r for r in rows if r["action"] in ("repoint", "rename")]
    nodes = sorted({r["node"] for r in todo})
    drv = connect()
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with drv.session(database=os.getenv("NEO4J_DATABASE") or "neo4j") as s:
        snap = [dict(r) for r in s.run(SNAPSHOT, names=nodes)]
        path = f"malformed_artist_names_presnapshot_{now[:19].replace(':', '')}.json"
        json.dump(snap, open(path, "w"), indent=1, default=str)
        print(f"snapshot of {len(snap)} nodes -> {path}")
        renamed = set()
        for r in todo:
            if r["action"] == "rename":
                if r["node"] in renamed:
                    continue
                target = r["targets"].split("|")[0]
                s.run(RENAME, node=r["node"], target=target).consume()
                renamed.add(r["node"])
                continue
            for spec in r["targets"].split("; "):
                name, q, kind = spec.split("|")
                s.run(ENSURE, name=name, node=r["node"]).consume()
                s.run(REPOINT_WORK, node=r["node"], workId=r["workId"], target=name, q=q or None).consume()
            s.run(DROP_OLD, node=r["node"], workId=r["workId"]).consume()
        deleted = sum(s.run(DELETE_EMPTY, node=n).single()["n"] for n in nodes if n not in renamed)
        left = [n for n in nodes if n not in renamed and
                s.run("MATCH (a:Artist {name: $n}) RETURN count(a) AS c", n=n).single()["c"]]
    print(f"{len(renamed)} nodes renamed, {deleted} emptied nodes deleted, "
          f"{len(todo) - sum(1 for r in todo if r['action'] == 'rename')} works re-pointed")
    if left:
        print(f"NOT deleted (still holding edges): {left}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan")
    p.add_argument("--out", default="malformed_artist_names_plan.csv")
    a = sub.add_parser("apply")
    a.add_argument("--plan", default="malformed_artist_names_plan.csv")
    args = ap.parse_args()
    {"plan": cmd_plan, "apply": cmd_apply}[args.cmd](args)


if __name__ == "__main__":
    main()
