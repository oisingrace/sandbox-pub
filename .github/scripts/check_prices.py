"""Checks the price of every product link in prices/watchlist.json and records it.

Run by the "Deploy site" workflow once a day (and right after the watch list changes).
Writes prices/history.json, which experiments/price-tracker.html reads.

    python3 .github/scripts/check_prices.py            # check every link
    python3 .github/scripts/check_prices.py --new-only # only links never checked before

How a price is found on a product page, in order:
  1. Structured product data (schema.org JSON-LD, which most shops include for Google)
  2. Price meta tags (product:price:amount, og:price:amount, itemprop="price")
  3. Shop-specific patterns (Amazon)
  4. A "pattern" regex given for that link in the watch list (one capture group = the price)
If plain HTTP fails or finds nothing, and Playwright is installed, the page is loaded
in a headless browser and checked again (for shops that build the page with JavaScript).

A new price is only stored when it changes, so the history stays small; every link
also records when it was last checked and the last error, if any.
"""
import argparse
import hashlib
import html
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
WATCHLIST = ROOT / "prices" / "watchlist.json"
HISTORY = ROOT / "prices" / "history.json"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9,en-US;q=0.8",
}
DELAY = 2.0  # seconds between requests to the same shop


# ---------- Small helpers ----------

def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "item"


def link_id(url):
    return hashlib.sha1(url.encode()).hexdigest()[:10]


def shop_name(url):
    host = urlparse(url).hostname or ""
    host = re.sub(r"^(www\d?|m|shop|store|smile)\.", "", host)
    parts = host.split(".")
    if len(parts) > 2 and len(parts[-2]) <= 3:  # amazon.co.uk, argos.co.uk
        name = parts[-3]
    else:
        name = parts[-2] if len(parts) >= 2 else parts[0]
    return name[:1].upper() + name[1:]


def parse_price(value):
    """'£1,234.56' / '1.234,56 €' / '1234' / 12.5 -> float, or None."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value) if value > 0 else None
    if not isinstance(value, str):
        return None
    s = re.sub(r"[^\d.,]", "", value.replace(" ", " "))
    if not re.search(r"\d", s):
        return None
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):          # 1.234,56
            s = s.replace(".", "").replace(",", ".")
        else:                                    # 1,234.56
            s = s.replace(",", "")
    elif "," in s:
        whole, _, frac = s.rpartition(",")
        s = (whole.replace(",", "") + "." + frac) if len(frac) == 2 else s.replace(",", "")
    elif s.count(".") > 1:                       # 1.234.567
        whole, _, frac = s.rpartition(".")
        s = whole.replace(".", "") + ("." + frac if len(frac) == 2 else frac)
    try:
        n = round(float(s), 2)
    except ValueError:
        return None
    return n if n > 0 else None


# ---------- Extraction ----------

class MetaParser(HTMLParser):
    """Collects <meta> tags, itemprop attributes and the <title>."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta = {}
        self.itemprops = {}
        self.title = ""
        self._in_title = False
        self._capture = None

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            key = (a.get("property") or a.get("name") or a.get("itemprop") or "").lower()
            if key and "content" in a:
                self.meta.setdefault(key, a["content"])
        if "itemprop" in a:
            prop = a["itemprop"].lower()
            if "content" in a:
                self.itemprops.setdefault(prop, a["content"])
            elif prop in ("price", "pricecurrency", "availability") and prop not in self.itemprops:
                self._capture = prop
        if tag == "title" and not self.title:
            self._in_title = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if self._capture and data.strip():
            self.itemprops[self._capture] = data.strip()
            self._capture = None


def _types(node):
    t = node.get("@type", "")
    return [x.lower() for x in (t if isinstance(t, list) else [t]) if isinstance(x, str)]


def _walk(node):
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from _walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk(v)


def _offer_prices(offers):
    """(price, currency, in_stock) for every offer in an offers value."""
    out = []
    for o in offers if isinstance(offers, list) else [offers]:
        if not isinstance(o, dict):
            continue
        cur = o.get("priceCurrency")
        avail = str(o.get("availability", "")).lower()
        stock = None if not avail else not any(w in avail for w in ("outofstock", "soldout", "discontinued"))
        price = parse_price(o.get("price")) or parse_price(o.get("lowPrice"))
        spec = o.get("priceSpecification")
        if price is None and spec:
            for s in spec if isinstance(spec, list) else [spec]:
                if isinstance(s, dict) and parse_price(s.get("price")):
                    price = parse_price(s.get("price"))
                    cur = cur or s.get("priceCurrency")
                    break
        if price is None and isinstance(o.get("offers"), (dict, list)):  # AggregateOffer > offers
            out.extend(_offer_prices(o["offers"]))
            continue
        if price is not None:
            out.append((price, cur, stock))
    return out


def from_json_ld(page):
    found = []
    for raw in re.findall(r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>", page, re.S | re.I):
        raw = raw.strip().removeprefix("<!--").removesuffix("-->").strip()
        raw = re.sub(r"^//\s*<!\[CDATA\[|//\s*\]\]>$", "", raw).strip()
        data = None
        for attempt in (raw, html.unescape(raw), re.sub(r"[\x00-\x1f]", " ", raw)):
            try:
                data = json.loads(attempt)
                break
            except ValueError:
                continue
        if data is None:
            continue
        for node in _walk(data):
            types = _types(node)
            if "offers" in node and (not types or any(t in ("product", "productgroup", "individualproduct", "vehicle", "book") for t in types)):
                found.extend(_offer_prices(node["offers"]))
    if not found:
        return None
    in_stock = [f for f in found if f[2] is not False]
    price, cur, stock = min(in_stock or found, key=lambda f: f[0])
    return {"price": price, "currency": cur, "inStock": stock, "via": "structured data"}


def from_meta(page):
    p = MetaParser()
    try:
        p.feed(page)
    except Exception:  # noqa: BLE001 - broken HTML shouldn't stop the run
        pass
    title = html.unescape(p.meta.get("og:title") or p.title).strip()
    for key, cur_key in (("product:price:amount", "product:price:currency"),
                         ("og:price:amount", "og:price:currency"),
                         ("product:sale_price:amount", "product:sale_price:currency")):
        price = parse_price(p.meta.get(key))
        if price:
            return {"price": price, "currency": p.meta.get(cur_key), "via": "meta tags"}, title
    price = parse_price(p.itemprops.get("price") or p.meta.get("price"))
    if price:
        avail = p.itemprops.get("availability", "").lower()
        return {"price": price, "currency": p.itemprops.get("pricecurrency"),
                "inStock": None if not avail else "outofstock" not in avail, "via": "page markup"}, title
    return None, title


def from_amazon(page):
    for pattern in (
        r'id="corePrice(?:Display)?_[^"]*".*?class="a-offscreen">\s*([^<]+)<',
        r'id="apex_desktop".*?class="a-offscreen">\s*([^<]+)<',
        r'"priceAmount"\s*:\s*([\d.]+)',
        r'id="priceblock_(?:ourprice|dealprice|saleprice)"[^>]*>\s*([^<]+)<',
        r'class="a-price[^"]*"[^>]*>\s*<span class="a-offscreen">\s*([^<]+)<',
    ):
        m = re.search(pattern, page, re.S)
        if m and parse_price(m.group(1)):
            return {"price": parse_price(m.group(1)), "via": "Amazon page"}
    return None


BLOCKED = re.compile(
    r"captcha|are you a robot|robot check|unusual traffic|access denied|"
    r"request unsuccessful|pardon our interruption|verify you are (a )?human|"
    r"enable javascript and cookies|attention required", re.I)


def extract(page, url, pattern=None):
    """Returns (result dict or None, page title)."""
    result = None
    if pattern:
        m = re.search(pattern, page, re.S)
        if m and parse_price(m.group(1) if m.groups() else m.group(0)):
            result = {"price": parse_price(m.group(1) if m.groups() else m.group(0)), "via": "custom pattern"}
    result = result or from_json_ld(page)
    meta, title = from_meta(page)
    result = result or meta
    if not result and "amazon." in (urlparse(url).hostname or ""):
        result = from_amazon(page)
    return result, title


# ---------- Fetching ----------

def fetch_http(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read(6_000_000)
        charset = r.headers.get_content_charset() or "utf-8"
        return r.status, body.decode(charset, errors="replace")


_browser = None


def fetch_browser(url):
    """Loads the page in headless Chromium, if Playwright is installed. Returns HTML or None."""
    global _browser
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return None
    if _browser is None:
        pw = sync_playwright().start()
        _browser = pw.chromium.launch()
    ctx = _browser.new_context(user_agent=UA, locale="en-GB", viewport={"width": 1366, "height": 900})
    try:
        page = ctx.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=45000)
        try:
            page.wait_for_load_state("networkidle", timeout=12000)
        except Exception:  # noqa: BLE001 - busy pages never go idle; use what loaded
            pass
        return page.content()
    finally:
        ctx.close()


def check(url, pattern=None):
    """Returns a dict with price/currency/inStock/title on success, or {'error': ...}."""
    error, page = None, None
    try:
        _, page = fetch_http(url)
    except urllib.error.HTTPError as e:
        error = f"The shop refused the request (HTTP {e.code})"
    except Exception as e:  # noqa: BLE001
        error = f"Couldn't load the page ({type(e).__name__})"

    if page:
        result, title = extract(page, url, pattern)
        if result:
            return {**result, "title": title}
        error = ("The shop showed a robot check instead of the page" if BLOCKED.search(page[:200000])
                 else "Couldn't find a price on the page")

    try:
        rendered = fetch_browser(url)
    except Exception as e:  # noqa: BLE001
        rendered = None
        error += f"; browser also failed ({type(e).__name__})"
    if rendered:
        result, title = extract(rendered, url, pattern)
        if result:
            return {**result, "title": title, "via": result["via"] + " (browser)"}
        if BLOCKED.search(rendered[:200000]):
            error = "The shop showed a robot check instead of the page"
    return {"error": error}


# ---------- Main ----------

def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def normalise_links(item):
    links = []
    for link in item.get("links", []):
        if isinstance(link, str):
            link = {"url": link}
        url = str(link.get("url", "")).strip()
        if not url.startswith(("http://", "https://")):
            continue
        links.append({"url": url, "name": str(link.get("name") or shop_name(url)),
                      "pattern": link.get("pattern")})
    return links


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--new-only", action="store_true", help="only check links that have never been checked")
    args = ap.parse_args()

    watch = load_json(WATCHLIST, {"items": []})
    history = load_json(HISTORY, {"items": {}})
    old_items = history.get("items", {})
    now = datetime.now(timezone.utc)
    today = now.date().isoformat()
    out_items = {}
    last_hit = {}
    checked = found = 0

    for item in watch.get("items", []):
        name = str(item.get("name", "")).strip()
        if not name:
            continue
        iid = str(item.get("id") or slug(name))
        old = old_items.get(iid, {})
        old_links = old.get("links", {})
        links = {}
        for link in normalise_links(item):
            lid = link_id(link["url"])
            rec = {**{"prices": []}, **old_links.get(lid, {}), "url": link["url"], "name": link["name"]}
            if args.new_only and rec.get("checked"):
                links[lid] = rec
                continue
            host = urlparse(link["url"]).hostname
            wait = DELAY - (time.time() - last_hit.get(host, 0))
            if wait > 0:
                time.sleep(wait)
            res = check(link["url"], link.get("pattern"))
            last_hit[host] = time.time()
            checked += 1
            rec["checked"] = now.isoformat(timespec="seconds")
            if "error" in res:
                rec["error"] = res["error"]
                print(f"  ✗ {name} @ {link['name']}: {res['error']}")
            else:
                found += 1
                rec.pop("error", None)
                rec["lastSuccess"] = rec["checked"]
                for k in ("currency", "inStock", "title", "via"):
                    if res.get(k) not in (None, ""):
                        rec[k] = res[k]
                prices = rec["prices"]
                if prices and prices[-1][0] == today:
                    prices[-1] = [today, res["price"]]
                    if len(prices) > 1 and prices[-2][1] == res["price"]:
                        prices.pop()
                elif not prices or prices[-1][1] != res["price"]:
                    prices.append([today, res["price"]])
                print(f"  ✓ {name} @ {link['name']}: {res['price']} {res.get('currency') or ''} via {res['via']}")
            links[lid] = rec
        out_items[iid] = {
            "name": name,
            "target": parse_price(item.get("target")) if item.get("target") not in (None, "") else None,
            "notes": str(item.get("notes", "")),
            "added": old.get("added") or today,
            "links": links,
        }

    history = {"updated": now.isoformat(timespec="seconds") if checked else history.get("updated"),
               "items": out_items}
    HISTORY.parent.mkdir(parents=True, exist_ok=True)
    HISTORY.write_text(json.dumps(history, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Checked {checked} link(s), found {found} price(s).")
    if _browser is not None:
        _browser.close()


if __name__ == "__main__":
    sys.exit(main())
