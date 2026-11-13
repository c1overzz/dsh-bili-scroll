"""A concurrent synthetic writer/exporter for storage integration tests."""
import sys
from bili_scroll.config import Config
from bili_scroll.storage import Store

store = Store(Config.load())
bv = 'BV1' + sys.argv[1] * 9
store.note(bv, 'Synthetic title', 'Synthetic author', 'unavailable', '', 'Synthetic no-content fixture')
store.report()
