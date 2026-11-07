# Price checks

`watchlist.json` lists the products whose prices get checked every day. Each item has a
name, an optional target price and notes, and one or more product links:

```json
{
  "items": [
    {
      "name": "Noise-cancelling headphones",
      "target": 249,
      "notes": "Black",
      "links": [
        "https://www.amazon.co.uk/dp/B0XXXXXXX",
        { "url": "https://www.example-shop.com/p/123", "name": "Example Shop" }
      ]
    }
  ]
}
```

The shop name comes from the link unless you give one. For a page where the price
can't be found automatically, add `"pattern"` to that link: a regular expression whose
first group is the price.

`.github/scripts/check_prices.py` visits every link, reads the price and saves it to
`history.json` (only when it changes, plus when each link was last checked and any error).
The Price Tracker page (`experiments/price-tracker.html`) shows that history.
