"""
PrintMasterAI — Execute Cypher Merge for 98% VLM-Confirmed Candidate Pairs
Version: MERGE-98-VLM-MATCHES-1.0
"""

import os
import sys
import logging
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

def run_merge_98_matches():
    pwd = get_neo4j_password()
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, pwd))

    # The 6 VLM-confirmed 98% candidate matches
    matches_98 = [
        {
            "artist": "Camille Pissarro",
            "posterCwId": "km-cw-camille_pissarro-the_boulevard_montmartre_at_night",
            "targetCwId": "swann-cw-Camille_Pissarro-Delteil-191-boulevard_montmartre"
        },
        {
            "artist": "Camille Pissarro",
            "posterCwId": "km-cw-camille_pissarro-the_boulevard_montmartre_at_night_1897",
            "targetCwId": "swann-cw-Camille_Pissarro-Delteil-191-boulevard_montmartre"
        },
        {
            "artist": "Giorgio Morandi",
            "posterCwId": "km-cw-giorgio_morandi-natura_morta_ii_1953",
            "targetCwId": "swann-cw-Giorgio_Morandi-Vitali-102-natura_morta"
        },
        {
            "artist": "Henry Moore",
            "posterCwId": "km-cw-henry_moore-nine_studies_for_family_group",
            "targetCwId": "bonhams-cw-Henry_Moore_O.M._C.H-Cramer-12-family_group"
        },
        {
            "artist": "Paul Cézanne",
            "posterCwId": "km-cw-paul_cézanne-mont_saint_victoire_1900",
            "targetCwId": "bonhams-cw-Paul_Cézanne-G._&_P.-E639-la_montagne_sainte_victoire"
        },
        {
            "artist": "Édouard Manet",
            "posterCwId": "km-cw-édouard_manet-berthe_morisot_with_a_bouquet_of_violets_1872",
            "targetCwId": "swann-cw-Édouard_Manet-Guérin-59-berthe_morisot"
        }
    ]

    logging.info(f"Executing Cypher merges for {len(matches_98)} 98% VLM-confirmed ConceptualWork candidate pairs...")

    with driver.session() as s:
        for m in matches_98:
            poster_id = m["posterCwId"]
            target_id = m["targetCwId"]
            
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
                MERGE (me:MergeEvent {mergedFromId: posterCw.id})
                SET me.mergedIntoId = targetCw.id,
                    me.timestamp = datetime(),
                    me.reason = 'vlm_98_percent_confirmed_merge'
                MERGE (me)-[:MERGED_INTO]->(targetCw)

                DETACH DELETE posterCw
            """, posterCwId=poster_id, targetCwId=target_id)
            
            logging.info(f"Merged [{m['artist']}] '{poster_id}' ===> '{target_id}'")

    driver.close()
    logging.info("All 98% VLM-confirmed merges executed successfully.")

if __name__ == "__main__":
    run_merge_98_matches()
