"""
PrintMasterAI — Aura Graph Analytics prototype: similarity + centrality
Version: GDS-PROTOTYPE-0.1 (ADR-0009)

Smoke-test prototype for ADR-0009 (docs/adr/0009-graph-analytics-precomputed-confidence.md):
does NOT write anything back to the main graph yet. Runs two algorithms against real ACKG
data via an ephemeral Aura Graph Analytics session and prints results, so we can see whether
the mechanics work and whether the output is actually useful before designing the real
feature encoding / write-back pipeline.

Requires TWO separate credential sets, not one — this tripped me up designing this, so it's
worth stating plainly:
  1. NEO4J_URI/USER/PASSWORD/DATABASE (knowledge_graph/.env.example) — the actual database.
  2. AURA_API_CLIENT_ID/AURA_API_CLIENT_SECRET — Aura *account* API credentials, generated
     from the Aura Console (account menu -> "Aura API and Credentials" -> Create), NOT the
     database password. These provision the ephemeral GDS compute session, separate from the
     database connection itself. Add them to .env alongside the NEO4J_* vars.

Three smoke tests, run independently:

  --test centrality
    Weighted degree centrality on the real Artist <-[:ATTRIBUTED_TO]- SourceRecord bipartite
    graph (a *direct* edge in the schema — no multi-hop projection needed), weighted by
    qualifier (direct=1.0, attributed_to=0.7, circle_of/manner_of/studio_of/follower_of=0.4,
    after/school_of=0.2) and by source layer (institutional vs auction — both counted, not
    yet split into separate scores; that refinement is real design work for later, not this
    smoke test). This is the "evidence strength" signal from ADR-0009 Decision 1b, in its
    simplest possible form.

  --test similarity
    Node similarity (Jaccard over shared neighbours) on a Cypher-projected bipartite
    Artist-Feature graph — collapses the real multi-hop path
    (Artist-CREATED->ConceptualWork-PRINTED_AS->EditionRun-INCLUDES->Impression-{USES_TECHNIQUE,
    PRINTED_ON,DEPICTS}->{Technique,Paper,Subject,Genre}) into virtual direct edges for the GDS
    projection only; nothing is written to the real graph. Per ADR-0009 Decision 1a, the feature
    profile is technique + paper + subject + genre — the controlled-vocabulary dimensions query_ackg
    already filters on that are represented as their own graph nodes, plus Genre (same direct
    Impression-[:CLASSIFIED_AS]->Genre shape, though real coverage is thin: ~510 classified
    Impressions against tens of thousands with technique/paper data — helps some ties without
    being universally applicable) and, as of doc 08 §8, Period and Region too. Those last two
    started out as plain properties (ConceptualWork.dateCreated_year, Artist.nationality) per
    doc 08 §5, and the obvious in-session workaround for turning a property into a projectable
    neighbour — apoc.create.vNode({bucket: 1970}) — was confirmed live NOT to work (three
    calls with identical properties returned three different internal ids, so two artists
    from the same decade would each get a private virtual node sharing nothing). Doc 08 §8
    documents the real fix actually taken: persisting genuine, deduplicated Period/Region
    nodes to the live graph via add_period_region_nodes.py, a small (186 node / 38,839
    relationship) one-time write, confirmed against headroom first. A first single-feature
    (technique-only) version of this test produced mostly meaningless 1.0-similarity ties
    between arbitrary artists who each only touch one or two techniques; folding in the other
    five dimensions helps a great deal but doesn't eliminate every tie — see the docstrings
    below for why some are a real structural fact, not a fixable gap.

  --test embeddings
    ADR-0009's named alternative to node similarity: FastRP embedding over the identical
    Artist-{Technique,Paper,Subject,Genre} projection, then cosine similarity computed in-process
    (numpy) rather than via discrete set overlap — a direct empirical comparison against
    --test similarity on the same underlying data, per ADR-0009's own open question of which
    algorithm to commit to.

Usage:
    python3 gds_prototype.py --test centrality --limit 20
    python3 gds_prototype.py --test similarity --limit 20
    python3 gds_prototype.py --test embeddings --limit 20
"""

import argparse
import os

import numpy as np
import pandas as pd
from graphdatascience.session import AuraAPICredentials, DbmsConnectionInfo, GdsSessions, SessionMemory
from neo4j import GraphDatabase


def _require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Copy knowledge_graph/.env.example to .env, fill in "
            f"the real values, and export them (e.g. `set -a; source .env; set +a`) "
            f"before running this script."
        )
    return value


NEO4J_URI = _require_env("NEO4J_URI")
NEO4J_USER = _require_env("NEO4J_USER")
NEO4J_PASSWORD = _require_env("NEO4J_PASSWORD")
NEO4J_DATABASE = _require_env("NEO4J_DATABASE")
AURA_API_CLIENT_ID = _require_env("AURA_API_CLIENT_ID")
AURA_API_CLIENT_SECRET = _require_env("AURA_API_CLIENT_SECRET")

# The subdomain of NEO4J_URI (neo4j+s://<this>.databases.neo4j.io) is the Aura instance ID
# the session needs to attach to — confirmed against this project's own .env.
AURA_INSTANCE_ID = NEO4J_URI.split("//")[1].split(".")[0]

SESSION_NAME = "printmaster-gds-prototype"

QUALIFIER_WEIGHTS = {
    "direct": 1.0,
    "attributed_to": 0.7,
    "circle_of": 0.4,
    "manner_of": 0.4,
    "studio_of": 0.4,
    "follower_of": 0.4,
    "after": 0.2,
    "school_of": 0.2,
}


def get_session():
    sessions = GdsSessions(
        api_credentials=AuraAPICredentials(AURA_API_CLIENT_ID, AURA_API_CLIENT_SECRET, None)
    )
    gds = sessions.get_or_create(
        session_name=SESSION_NAME,
        memory=SessionMemory.m_2GB,  # smallest tier — this graph is ~190k nodes, well within it
        db_connection=DbmsConnectionInfo(
            uri=NEO4J_URI,
            username=NEO4J_USER,
            password=NEO4J_PASSWORD,
            database=NEO4J_DATABASE,
        ),
    )
    return sessions, gds


def resolve_node_names(db_ids):
    """Resolves real internal Neo4j ids (id(n)) back to human-readable names, via a plain
    direct query against the actual database — NOT through the GDS session, which can only
    carry numeric properties. Label-agnostic (works for Artist.name, Technique.name, etc.)
    since the similarity smoke test's node2 may be either."""
    if not db_ids:
        return {}
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            result = session.run(
                "MATCH (n) WHERE id(n) IN $ids RETURN id(n) AS dbId, coalesce(n.name, n.id) AS name",
                ids=db_ids,
            )
            return {r["dbId"]: r["name"] for r in result}
    finally:
        driver.close()


def resolve_node_labels(db_ids):
    """Same pattern as resolve_node_names, for the primary label (labels(n)[0]) — needed
    because the multi-feature similarity projection below mixes Artist, Technique, Paper,
    and Subject nodes in one graph, and gds.nodeSimilarity.stream scores every pair with
    shared neighbours regardless of label, not just the Artist-Artist pairs we actually
    want. Filtering has to happen after the fact via a plain Cypher lookup, since GDS
    node properties are numeric-only (see the dbId pattern throughout this file)."""
    if not db_ids:
        return {}
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            result = session.run(
                "MATCH (n) WHERE id(n) IN $ids RETURN id(n) AS dbId, labels(n)[0] AS label",
                ids=db_ids,
            )
            return {r["dbId"]: r["label"] for r in result}
    finally:
        driver.close()


def resolve_artist_dbid(name):
    """Looks up one Artist's internal id by name for a targeted --artist query — checks
    alternateNames too (doc 08 principle 7a: the same real person can appear under multiple
    name forms across sources), case-insensitively since CLI input won't match casing exactly."""
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            result = session.run(
                """
                MATCH (a:Artist)
                WHERE toLower(a.name) = toLower($name)
                   OR toLower($name) IN [n IN coalesce(a.alternateNames, []) | toLower(n)]
                RETURN id(a) AS dbId, a.name AS canonicalName
                """,
                name=name,
            )
            matches = [(r["dbId"], r["canonicalName"]) for r in result]
            if not matches:
                raise ValueError(f"No Artist node found matching name '{name}'.")
            if len(matches) > 1:
                names = ", ".join(f"{n} (dbId {i})" for i, n in matches)
                print(f"Warning: '{name}' matched {len(matches)} Artist nodes — using the first: {names}")
            return matches[0]
    finally:
        driver.close()


def run_centrality_smoke_test(gds, limit):
    print("Projecting Artist <-[:ATTRIBUTED_TO]- SourceRecord (weighted by qualifier)...")
    # Modern Cypher projection: gds.graph.project.remote(...) is an AGGREGATION function
    # (like count(*)) called once per matched row, not a two-string node/relationship query
    # pair — that older two-argument form doesn't exist on the installed client version
    # (confirmed directly against the package: GraphCypherRunner.project takes ONE query
    # string ending in this call, not two). `.remote` specifically because this runs against
    # a GDS *session* — compute separate from the database — not a plugin installed
    # in-database.
    # Cypher map literals use unquoted keys ({direct: 1.0, ...}), unlike Python/JSON dict
    # syntax — f-stringing QUALIFIER_WEIGHTS directly produced invalid Cypher the first time
    # this ran (quoted keys), caught by the actual server error, not anticipated in advance.
    cypher_map_literal = "{" + ", ".join(f"{k}: {v}" for k, v in QUALIFIER_WEIGHTS.items()) + "}"
    # Node properties projected into GDS must be numeric — a real server error confirmed
    # this the hard way (string `name` property rejected outright: "contained a value of
    # type String, which is not supported"). So we project id(n) as a numeric `dbId`
    # instead, and resolve human-readable names afterward via a plain Cypher call directly
    # against the real database (resolve_names, below) — not through the GDS session at all.
    # Source/target are deliberately Artist -> SourceRecord (reverse of the real ATTRIBUTED_TO
    # direction), not a typo: gds.degree.stream's default orientation (NATURAL) scores
    # out-degree, so this is what puts the weighted "evidence strength" score on the Artist
    # nodes we actually want ranked, instead of on the SourceRecord nodes. Confirmed the hard
    # way — projecting src->a first put all the score on SourceRecord ids like
    # "met-691045-record" with Artist nodes stuck at 0.
    query = f"""
    MATCH (src:SourceRecord)-[att:ATTRIBUTED_TO]->(a:Artist)
    WITH src, a, coalesce({cypher_map_literal}[att.qualifier], 0.3) AS weight
    RETURN gds.graph.project.remote(a, src, {{
      sourceNodeLabels: labels(a),
      targetNodeLabels: labels(src),
      sourceNodeProperties: {{ dbId: id(a) }},
      targetNodeProperties: {{ dbId: id(src) }},
      relationshipProperties: {{ weight: weight }}
    }})
    """
    # Confirmed against the installed package: sessions expose a remote-projection runner
    # at gds.graph.project(graph_name, query) directly (GraphProjectRemoteRunner.__call__)
    # — NOT gds.graph.cypher.project, which belongs to the plain/local client class and
    # isn't present on a session's namespace at all (confirmed via the actual error).
    G, _ = gds.graph.project("centrality-prototype", query)
    print(f"Projected graph: {G.node_count()} nodes, {G.relationship_count()} relationships")

    result = gds.degree.stream(G, relationshipWeightProperty="weight")
    # The real bug (found by reading arrow_query_runner.py directly): this client's
    # nodeProperties.stream forwards config["listNodeLabels"] straight through as a
    # positional None when not set, which the Arrow server can't deserialize into its
    # boolean field. Passing it explicitly avoids the null. separate_property_columns
    # is unrelated and left at its long-format default (nodeId, nodeProperty, propertyValue).
    db_ids = gds.graph.nodeProperties.stream(G, ["dbId"], listNodeLabels=False).rename(
        columns={"propertyValue": "dbId"}
    )
    result = result.merge(db_ids[["nodeId", "dbId"]], on="nodeId", how="left")

    top = result.sort_values("score", ascending=False).head(limit)
    G.drop()

    names = resolve_node_names(top["dbId"].dropna().astype(int).tolist())
    top["name"] = top["dbId"].map(names)
    return top


def project_artist_feature_graph(gds, graph_name):
    """Shared by both the discrete-similarity and FastRP-embedding tests — same
    Artist-{Technique,Paper,Subject,Genre,Period,Region} bipartite profile, just fed to two
    different algorithms so their outputs can be compared on identical input.

    Period and Region are real graph nodes as of doc 08 §8 (added specifically for this
    prototype, after confirming the apoc.create.vNode workaround doesn't give stable shared
    identity across rows — see that doc section for why). Period attaches to ConceptualWork
    (cw is now a named/bound variable to reach it); Region attaches directly to Artist, no
    multi-hop needed. OPTIONAL MATCH throughout since not every record has every dimension
    (doc 08 §4.1 — Matrix/State go unpopulated on plenty of real records; the same
    graceful-degradation reality applies here). UNWIND + WHERE IS NOT NULL turns the six
    optional matches into one flat (artist, feature) row set; DISTINCT collapses an artist
    with 50 impressions of the same technique down to one edge, which is what we want for a
    profile, not a multiplicity count."""
    print(f"Projecting Artist-{{Technique,Paper,Subject,Genre,Period,Region}} bipartite graph as '{graph_name}'...")
    query = """
    MATCH (a:Artist)-[:CREATED]->(cw:ConceptualWork)-[:PRINTED_AS]->(:EditionRun)
          -[:INCLUDES]->(imp:Impression)
    OPTIONAL MATCH (imp)-[:USES_TECHNIQUE]->(t:Technique)
    OPTIONAL MATCH (imp)-[:PRINTED_ON]->(p:Paper)
    OPTIONAL MATCH (imp)-[:DEPICTS]->(s:Subject)
    OPTIONAL MATCH (imp)-[:CLASSIFIED_AS]->(g:Genre)
    OPTIONAL MATCH (cw)-[:DATED_TO]->(per:Period)
    OPTIONAL MATCH (a)-[:FROM_REGION]->(reg:Region)
    UNWIND [t, p, s, g, per, reg] AS feature
    WITH DISTINCT a, feature
    WHERE feature IS NOT NULL
    RETURN gds.graph.project.remote(a, feature, {
      sourceNodeLabels: labels(a),
      targetNodeLabels: labels(feature),
      sourceNodeProperties: { dbId: id(a) },
      targetNodeProperties: { dbId: id(feature) },
      relationshipType: "HAS_FEATURE"
    })
    """
    # undirected_relationship_types matters a lot here, confirmed the hard way: the real
    # ATTRIBUTED_TO-derived edges only run Artist->Feature, so a directed projection leaves
    # every Feature node with out-degree 0 — a dead end. FastRP's iterative propagation
    # (run_embeddings_smoke_test) stalls there and produces near-all-zero embeddings for
    # Artist nodes past iteration 1; nodeSimilarity happens to tolerate the directed form
    # because Jaccard only ever reads each Artist's own out-neighbours, but FastRP doesn't.
    # Marking the edge type undirected fixes both, and is the semantically correct choice
    # anyway — "shares a technique with" has no real direction.
    G, _ = gds.graph.project(graph_name, query, undirected_relationship_types=["HAS_FEATURE"])
    print(f"Projected graph: {G.node_count()} nodes, {G.relationship_count()} relationships")
    return G


def _filter_pairs_to_artist(result, target_dbid):
    """Flattens a dbId1/dbId2/similarity dataframe down to the rows involving one specific
    artist, normalized to a single 'otherDbId' column — the global top-N tests keep both
    sides since they don't know in advance which side a match lands on; a single-artist
    query does, so this collapses it into a plain ranked neighbour list."""
    matched = result[(result["dbId1"] == target_dbid) | (result["dbId2"] == target_dbid)].copy()
    matched["otherDbId"] = np.where(matched["dbId1"] == target_dbid, matched["dbId2"], matched["dbId1"])
    return matched


def run_similarity_smoke_test(gds, limit, artist_name=None):
    G = project_artist_feature_graph(gds, "similarity-prototype")

    # degreeCutoff excludes source-side nodes with fewer than this many distinct feature
    # neighbours before similarity is even computed — without it, two artists who each
    # have exactly one Impression sharing one Technique trivially score a perfect 1.0,
    # which is what the first run of this test actually returned (Jean Holabird vs. Dove
    # Bradshaw, etc. — real names, but the "similarity" is an artifact of both having a
    # single-feature profile, not a meaningful signal). 5 is a first guess, not tuned.
    # For a single named --artist query, relax both knobs: a lower degreeCutoff avoids
    # silently excluding the requested artist if their own profile happens to be thin, and
    # a higher topK gives a fuller neighbour list for the one artist actually asked about,
    # rather than the broad top-N-across-everyone scan the defaults are tuned for.
    degree_cutoff = 1 if artist_name else 5
    top_k = 25 if artist_name else 5
    result = gds.nodeSimilarity.stream(G, topK=top_k, degreeCutoff=degree_cutoff)
    db_ids = gds.graph.nodeProperties.stream(G, ["dbId"], listNodeLabels=False).rename(
        columns={"propertyValue": "dbId"}
    )[["nodeId", "dbId"]]
    result = result.merge(db_ids.rename(columns={"nodeId": "node1", "dbId": "dbId1"}), on="node1", how="left")
    result = result.merge(db_ids.rename(columns={"nodeId": "node2", "dbId": "dbId2"}), on="node2", how="left")

    G.drop()

    # nodeSimilarity scores every pair of source-side nodes with overlapping neighbours,
    # not just Artist-Artist pairs — with Technique/Paper/Subject also on the source side
    # of some other artist's edge, it'll happily also score Technique-vs-Technique overlap.
    # We only want Artist-Artist comparisons, so filter by real label after the fact
    # (GDS itself can't carry the string label as a projected property — see dbId pattern).
    all_ids = result["dbId1"].dropna().astype(int).tolist() + result["dbId2"].dropna().astype(int).tolist()
    labels = resolve_node_labels(all_ids)
    result["label1"] = result["dbId1"].map(labels)
    result["label2"] = result["dbId2"].map(labels)
    result = result[(result["label1"] == "Artist") & (result["label2"] == "Artist")]

    if artist_name:
        target_dbid, canonical_name = resolve_artist_dbid(artist_name)
        matched = _filter_pairs_to_artist(result, target_dbid)
        # nodeSimilarity computes each node's own topK list independently, so if both
        # Trevelyan->X and X->Trevelyan land in the result, the same pair shows up twice —
        # confirmed on a real run (Cecil Collins appeared twice at an identical 0.6875).
        # One row per neighbour is what a "who is similar to X" answer should show.
        matched = matched.drop_duplicates(subset=["otherDbId"])
        top = matched.sort_values("similarity", ascending=False).head(limit)
        names = resolve_node_names(top["otherDbId"].dropna().astype(int).tolist())
        top["name1"] = canonical_name
        top["name2"] = top["otherDbId"].map(names)
        return top[["name1", "name2", "similarity"]]

    top = result.sort_values("similarity", ascending=False).head(limit)
    names = resolve_node_names(top["dbId1"].dropna().astype(int).tolist() + top["dbId2"].dropna().astype(int).tolist())
    top["name1"] = top["dbId1"].map(names)
    top["name2"] = top["dbId2"].map(names)
    return top[["name1", "name2", "similarity"]]


def run_embeddings_smoke_test(gds, limit, embedding_dimension=64, artist_name=None):
    """ADR-0009's other named option: FastRP embedding + cosine similarity, over the exact
    same Artist-feature profile the discrete Jaccard test uses (project_artist_feature_graph).
    Motivation, confirmed by the similarity test's own real output: Jaccard over a small
    controlled vocabulary (a few dozen Technique/Paper/Subject nodes total) ties heavily at
    exact 1.0, because many long-tail artists coincidentally land on identical small feature
    sets — a property of discrete set overlap on a coarse vocabulary. This test exists to see
    whether a continuous embedding ranks the *same* small vocabulary any more informatively —
    not because the earlier result was a bug.

    Note: this test needs the same degree-richness filter as the discrete one, and for the
    identical reason — a real first run (no filter) produced the same class of degenerate
    1.0 ties (Sir Frank William Brangwyn vs. Amelia Sarah Levetus, etc.): two artists with a
    single, identical feature neighbour genuinely do get an identical structural embedding,
    not just an identical Jaccard score. Continuous vectors don't fix a coarse vocabulary by
    themselves.
    """
    G = project_artist_feature_graph(gds, "embedding-prototype")

    degree = gds.degree.stream(G)
    result = gds.fastRP.stream(G, embeddingDimension=embedding_dimension, randomSeed=42)
    db_ids = gds.graph.nodeProperties.stream(G, ["dbId"], listNodeLabels=False).rename(
        columns={"propertyValue": "dbId"}
    )[["nodeId", "dbId"]]
    result = result.merge(db_ids, on="nodeId", how="left")
    result = result.merge(degree[["nodeId", "score"]].rename(columns={"score": "degree"}), on="nodeId", how="left")
    G.drop()

    ids = result["dbId"].dropna().astype(int).tolist()
    labels = resolve_node_labels(ids)
    result["label"] = result["dbId"].map(labels)
    # Same degreeCutoff=5 threshold as the Jaccard test, for a direct comparison on equal
    # footing rather than one test being filtered and the other not. Relaxed to 1 for a
    # single named --artist query, same reasoning as the Jaccard test: don't silently drop
    # the one artist actually asked about just because their own profile is thin.
    min_degree = 1 if artist_name else 5
    artists = result[(result["label"] == "Artist") & (result["degree"] >= min_degree)].copy()

    names = resolve_node_names(artists["dbId"].astype(int).tolist())
    artists["name"] = artists["dbId"].map(names)

    # Cosine similarity computed directly in-process (numpy), not via a second GDS
    # algorithm call — with only ~4-5k artist embeddings this is a trivial dense matrix,
    # and it keeps this smoke test decoupled from whichever k-NN procedure name/config
    # this client version happens to expose.
    embeddings = np.array(artists["embedding"].tolist(), dtype=np.float32)
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    normalized = embeddings / norms
    similarity_matrix = normalized @ normalized.T

    names_arr = artists["name"].tolist()

    if artist_name:
        dbid_list = artists["dbId"].astype(int).tolist()
        target_dbid, canonical_name = resolve_artist_dbid(artist_name)
        if target_dbid not in dbid_list:
            raise ValueError(
                f"'{artist_name}' (dbId {target_dbid}) has no features in the projected graph "
                f"— it has zero Technique/Paper/Subject/Genre/Period/Region neighbours to compare on."
            )
        i = dbid_list.index(target_dbid)
        order = np.argsort(-similarity_matrix[i])
        rows = [
            (canonical_name, names_arr[j], float(similarity_matrix[i, j]))
            for j in order
            if j != i
        ]
        top = pd.DataFrame(rows, columns=["name1", "name2", "similarity"])
        return top.head(limit)

    rows = []
    top_k = 5
    for i in range(len(names_arr)):
        order = np.argsort(-similarity_matrix[i])
        count = 0
        for j in order:
            if j == i:
                continue
            rows.append((names_arr[i], names_arr[j], float(similarity_matrix[i, j])))
            count += 1
            if count >= top_k:
                break

    top = pd.DataFrame(rows, columns=["name1", "name2", "similarity"])
    return top.sort_values("similarity", ascending=False).head(limit)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--test", choices=["centrality", "similarity", "embeddings"], required=True)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument(
        "--artist",
        default=None,
        help="Name a specific Artist to rank neighbours for (--test similarity/embeddings "
        "only), instead of the default global top-N-across-everyone scan.",
    )
    args = parser.parse_args()

    sessions, gds = get_session()
    try:
        if args.test == "centrality":
            top = run_centrality_smoke_test(gds, args.limit)
        elif args.test == "similarity":
            top = run_similarity_smoke_test(gds, args.limit, artist_name=args.artist)
        else:
            top = run_embeddings_smoke_test(gds, args.limit, artist_name=args.artist)
        print(top.to_string())
    finally:
        sessions.delete(session_name=SESSION_NAME)
        print(f"\nSession '{SESSION_NAME}' deleted.")
