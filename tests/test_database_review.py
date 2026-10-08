"""The review page exposes only the publishable Supabase configuration."""
import os
import unittest
from unittest.mock import patch

from web.app import SECCIONES, app


class DatabaseReviewPageTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_without_key_page_fails_closed(self):
        with patch.dict(os.environ, SUPABASE_URL="https://oqbqdngieifjlgbppvey.supabase.co", SUPABASE_PUBLISHABLE_KEY="", clear=False):
            response = self.client.get("/base-de-datos/revision")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"chartbay.review.js", response.data)
        self.assertIn(b'data-supabase-key=""', response.data)
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_only_publishable_key_and_project_origin_reach_browser(self):
        with patch.dict(os.environ, SUPABASE_URL="https://oqbqdngieifjlgbppvey.supabase.co", SUPABASE_PUBLISHABLE_KEY="sb_publishable_test", SUPABASE_SECRET_KEY="sb_secret_private", clear=False):
            response = self.client.get("/base-de-datos/revision")
        self.assertIn(b"sb_publishable_test", response.data)
        self.assertNotIn(b"sb_secret_private", response.data)
        self.assertIn("connect-src 'self' https://oqbqdngieifjlgbppvey.supabase.co", response.headers["Content-Security-Policy"])
        self.assertNotIn("oqbqdngieifjlgbppvey.supabase.co", self.client.get("/base-de-datos").headers["Content-Security-Policy"])

    def test_secret_or_other_origin_is_rejected(self):
        for url, key in (("https://evil.example", "sb_publishable_test"), ("https://oqbqdngieifjlgbppvey.supabase.co", "sb_secret_private")):
            with self.subTest(url=url, key=key), patch.dict(os.environ, SUPABASE_URL=url, SUPABASE_PUBLISHABLE_KEY=key, clear=False):
                response = self.client.get("/base-de-datos/revision")
                self.assertIn(b'data-supabase-key=""', response.data)
                self.assertNotIn(b"sb_secret_private", response.data)

    def test_section_flag_also_hides_review(self):
        with patch.dict(SECCIONES, base_datos=False):
            self.assertEqual(self.client.get("/base-de-datos/revision").status_code, 404)


if __name__ == "__main__":
    unittest.main()
