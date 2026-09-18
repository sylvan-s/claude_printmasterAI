"""
PrintMasterAI — Poster ConceptualWork Title Reconciliation & Merge Pipeline
Version: RECONCILE-POSTER-CW-2.0

Reconciles poster `ConceptualWork` nodes with existing auction/institutional `ConceptualWork` nodes
by matching artwork titles, normalized title slugs, and catalogue-raisonné ID slugs.
"""

import os
import sys
import logging
import re
from neo4j import GraphDatabase

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

NEO4J_URI = os.getenv("NEO4J_URI", "bolt://145.241.203.210:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD_FILE = os.path.expanduser("~/.oci/printmaster_neo4j_password.txt")

def get_neo4j_password() -> str:
    if os.getenv("NEO4J_PASSWORD"):
        return os.getenv("NEO4J_PASSWORD", "")
    if os.path.exists(NEO4J_PASSWORD_FILE):
        with open(NEO4J_PASSWORD_FILE) as f:
            return f.read().strip()
    return ""

def clean_title_slug(text: str) -> str:
    if not text:
        return ""
    text = text.lower()

    text = re.sub(r"\(.*?\)", "", text)
    text = re.sub(r"\[.*?\]", "", text)
    text = re.sub(r"\b(18|19|20)\d{2}\b", "", text)
    text = re.sub(r"[^\w\s]", " ", text)
    
    tokens = text.split()
    ignore_words = {"the", "a", "an", "and", "of", "in", "by", "detail", "la", "le", "les", "de", "du", "des", "der", "die", "das"}
    tokens = [t for t in tokens if t not in ignore_words and len(t) > 1]
    return " ".join(tokens)

def extract_slug_from_id(cw_id: str) -> str:
    parts = cw_id.split("-")
    if len(parts) >= 3:
        last_part = parts[-1]
        if not last_part.isdigit() and len(last_part) > 2:
            return clean_title_slug(last_part.replace("_", " "))
    return ""

def run_reconciliation(execute: bool = False):
    pwd = get_neo4j_password()
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, pwd))

    with driver.session() as s:
        poster_cws = s.run("""
            MATCH (a:Artist)-[:CREATED]->(cw_poster:ConceptualWork)
            WHERE cw_poster.id STARTS WITH 'km-cw-'
            RETURN a.name AS artist, cw_poster.id AS posterCwId, cw_poster.title AS posterTitle
        """).data()

        logging.info(f"Analyzing {len(poster_cws)} poster ConceptualWork nodes for title matching...")

        matches = []
        for item in poster_cws:
            artist = item["artist"]
            poster_cw_id = item["posterCwId"]
            poster_title = item["posterTitle"] or ""
            poster_slug = clean_title_slug(poster_title)

            if not poster_slug:
                continue

            candidates = s.run("""
                MATCH (a:Artist {name: $artist})-[:CREATED]->(cw_other:ConceptualWork)
                WHERE NOT cw_other.id STARTS WITH 'km-cw-'
                OPTIONAL MATCH (sr:SourceRecord)-[:DOCUMENTS]->(cw_other)
                RETURN cw_other.id AS otherCwId, cw_other.title AS cwTitle, collect(DISTINCT sr.title) AS srTitles
            """, artist=artist).data()

            best_match = None
            for cand in candidates:
                other_id = cand["otherCwId"]
                other_cw_title = cand["cwTitle"] or ""
                sr_titles = cand["srTitles"] or []

                target_slugs = set()
                if other_cw_title:
                    target_slugs.add(clean_title_slug(other_cw_title))
                for st in sr_titles:
                    if st:
                        target_slugs.add(clean_title_slug(st))
                id_slug = extract_slug_from_id(other_id)
                if id_slug:
                    target_slugs.add(id_slug)

                p_words = set(poster_slug.split())
                for t_slug in target_slugs:
                    if not t_slug:
                        continue
                    t_words = set(t_slug.split())
                    
                    if poster_slug == t_slug or (p_words == t_words and len(p_words) >= 1):
                        best_match = (other_id, t_slug)
                        break
                    elif len(p_words) >= 2 and len(p_words & t_words) >= 2 and (len(p_words & t_words) / len(p_words)) >= 0.75:
                        best_match = (other_id, t_slug)
                        break
                
                if best_match:
                    matches.append({
                        "artist": artist,
                        "posterCwId": poster_cw_id,
                        "posterTitle": poster_title,
                        "targetCwId": best_match[0],
                        "matchedSlug": best_match[1]
                    })
                    break

        logging.info(f"Total Title Merges Identified via Method 1 (Title/Slug Matching): {len(matches)}")
        
        print("\n--- SAMPLE TITLE MERGES (METHOD 1) ---")
        for m in matches[:20]:
            print(f" • [{m['artist']}] Poster: \"{m['posterTitle']}\" ({m['posterCwId']}) ===> Target Work ({m['targetCwId']})")

        if execute and matches:
            logging.info(f"Executing Cypher merge for {len(matches)} matched ConceptualWorks...")
            for m in matches:
                s.run("""
                    MATCH (posterCw:ConceptualWork {id: $posterCwId})
                    MATCH (targetCw:ConceptualWork {id: $targetCwId})
                    WHERE posterCw <> targetCw
                    
                    WITH posterCw, targetCw
                    OPTIONAL MATCH (sr:SourceRecord)-[r1:DOCUMENTS]->(posterCw)
                    FOREACH (_ IN CASE WHEN sr IS NOT NULL THEN [1] ELSE [] END |
                        MERGE (sr)-[:DOCUMENTS]->(targetCw)
                        DELETE r1
                    )

                    WITH posterCw, targetCw
                    OPTIONAL MATCH (img:DigitalImage)-[r2:SHOWS]->(posterCw)
                    FOREACH (_ IN CASE WHEN img IS NOT NULL THEN [1] ELSE [] END |
                        MERGE (img)-[:SHOWS]->(targetCw)
                        DELETE r2
                    )

                    WITH posterCw, targetCw
                    OPTIONAL MATCH (posterCw)-[r3:PRINTED_AS]->(ed:EditionRun)
                    FOREACH (_ IN CASE WHEN ed IS NOT NULL THEN [1] ELSE [] END |
                        MERGE (targetCw)-[:PRINTED_AS]->(ed)
                        DELETE r3
                    )

                    WITH posterCw, targetCw
                    MERGE (m:MergeEvent {mergedFromId: posterCw.id})
                    SET m.mergedIntoId = targetCw.id,
                        m.timestamp = datetime(),
                        m.reason = 'title_slug_reconciliation'
                    MERGE (m)-[:MERGED_INTO]->(targetCw)

                    DETACH DELETE posterCw
                """, posterCwId=m["posterCwId"], targetCwId=m["targetCwId"])
            logging.info(f"Successfully consolidated {len(matches)} ConceptualWorks in ACKG!")

    driver.close()
    return len(matches)

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true", help="Execute Cypher merges (default is dry-run)")
    args = parser.parse_args()
    run_reconciliation(execute=args.execute)
