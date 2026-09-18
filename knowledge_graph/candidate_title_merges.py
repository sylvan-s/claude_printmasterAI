"""
PrintMasterAI — RapidFuzz + Slug Normalization ConceptualWork Candidate Finder
Version: CANDIDATE-TITLE-MERGES-1.0

Finds candidate ConceptualWork merges across Poster and Auction/Museum datasets
grouped by Artist using RapidFuzz token set ratio and slug normalization (> 85% match).
"""

import os
import sys
import logging
import re
from typing import List, Dict, Any
from rapidfuzz import fuzz
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

def find_candidate_title_matches(min_score: float = 85.0) -> List[Dict[str, Any]]:
    pwd = get_neo4j_password()
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, pwd))

    candidates = []
    with driver.session() as s:
        # Fetch poster artists and their ConceptualWorks
        poster_works = s.run("""
            MATCH (a:Artist {hasPosterCatalog: true})-[:CREATED]->(cw_poster:ConceptualWork)
            WHERE cw_poster.id STARTS WITH 'km-cw-'
            RETURN a.name AS artist, cw_poster.id AS posterCwId, cw_poster.title AS posterTitle
            ORDER BY artist, posterTitle
        """).data()

        logging.info(f"Loaded {len(poster_works)} poster ConceptualWork nodes for evaluation.")

        for pwork in poster_works:
            artist = pwork["artist"]
            poster_id = pwork["posterCwId"]
            poster_title = pwork["posterTitle"] or ""
            p_slug = clean_title_slug(poster_title)

            if not p_slug:
                continue

            # Query non-poster ConceptualWorks for the SAME artist
            auction_works = s.run("""
                MATCH (a:Artist {name: $artist})-[:CREATED]->(cw_other:ConceptualWork)
                WHERE NOT cw_other.id STARTS WITH 'km-cw-'
                OPTIONAL MATCH (sr:SourceRecord)-[:DOCUMENTS]->(cw_other)
                RETURN cw_other.id AS otherCwId, cw_other.title AS cwTitle, collect(DISTINCT sr.title) AS srTitles
            """, artist=artist).data()

            best_match = None
            max_score = 0.0

            for awork in auction_works:
                other_id = awork["otherCwId"]
                cw_title = awork["cwTitle"] or ""
                sr_titles = awork["srTitles"] or []

                target_candidates = []
                if cw_title:
                    target_candidates.append(cw_title)
                for st in sr_titles:
                    if st:
                        target_candidates.append(st)
                id_slug = extract_slug_from_id(other_id)
                if id_slug:
                    target_candidates.append(id_slug.title())

                for t_raw in target_candidates:
                    t_slug = clean_title_slug(t_raw)
                    if not t_slug:
                        continue
                    
                    # Compute RapidFuzz similarity metrics
                    score_sort = fuzz.token_sort_ratio(p_slug, t_slug)
                    score_set = fuzz.token_set_ratio(p_slug, t_slug)
                    score_ratio = fuzz.ratio(p_slug, t_slug)

                    # Combined weighted score favoring token set ratio
                    combined_score = round(max(score_set, (score_sort * 0.5 + score_ratio * 0.5)), 1)

                    if combined_score >= min_score and combined_score > max_score:
                        max_score = combined_score
                        best_match = {
                            "artist": artist,
                            "posterCwId": poster_id,
                            "posterTitle": poster_title,
                            "targetCwId": other_id,
                            "targetTitle": t_raw,
                            "similarityScore": combined_score
                        }

            if best_match:
                candidates.append(best_match)

    driver.close()
    
    # Sort candidates by artist name, then highest score descending
    candidates.sort(key=lambda x: (x["artist"], -x["similarityScore"]))
    return candidates

if __name__ == "__main__":
    candidates = find_candidate_title_matches(min_score=85.0)
    print(f"\nFound {len(candidates)} candidate matches with similarity >= 85.0%\n")
    for c in candidates:
        print(f"[{c['similarityScore']}%] {c['artist']} | Poster: \"{c['posterTitle']}\" ({c['posterCwId']}) <===> Auction: \"{c['targetTitle']}\" ({c['targetCwId']})")
