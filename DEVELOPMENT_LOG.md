# Development Log

This document captures ongoing research, discoveries, and debugging notes for the tvhomerun-backend project.

---

## 2025-11-26: HDHomeRun Progress Update API Discovery

### Problem
Need to update playback progress (Resume position) on HDHomeRun devices via HTTP API. The official documentation doesn't cover this functionality.

### Investigation Process

**Initial Attempts (All Failed):**
- POST with form data to `cmd_url`: 400 Bad Request
- GET with query parameters: 400 Bad Request
- PUT with form data: Empty reply
- Various parameter combinations: All failed

**Breakthrough Method:**
Used `tcpdump` to snoop on network traffic between the official HDHomeRun app and the device:
```bash
sudo tcpdump -i any -A host 192.168.0.37 and port 80
```

### Solution

**Correct API Format:**
```
POST /recorded/cmd?id={episode_id}&cmd=set&Resume={position}
```

**Key Details:**
- Method: `POST` (with null/empty body)
- `cmd=set` parameter is **required**
- `Resume` is a **query parameter** (not form data)
- No request body needed
- Returns: `200 OK` on success

**Special Values:**
- `Resume=4294967295` (max uint32): Marks episode as "watched"
- `Resume=0`: Resets to beginning
- Any other value: Resume position in seconds

**Example Requests:**
```bash
# Set resume position to 682 seconds
curl -X POST "http://192.168.0.37/recorded/cmd?id=901f4f1362e3b3a8&cmd=set&Resume=682"

# Mark as watched
curl -X POST "http://192.168.0.37/recorded/cmd?id=901f4f1362e3b3a8&cmd=set&Resume=4294967295"
```

### Code Changes

**Files Updated:**
1. `src/server.js`: `relayProgressToHDHomeRun()` method
2. `src/device-progress.js`: `setProgressOnDevice()` method

**Implementation:**
```javascript
const resumeValue = watched ? '4294967295' : position.toString();
const url = `${cmdUrl}&cmd=set&Resume=${resumeValue}`;
await axios.post(url, null, { timeout: 5000 });
```

### Lessons Learned

1. **Network traffic analysis is essential** when working with undocumented APIs
2. **Document discoveries** - undocumented APIs need extra documentation
3. **Test assumptions systematically** - we missed `cmd=set` parameter initially

### Future Investigation Ideas

- Other `cmd` parameter values (what else does `cmd` support?)
- Batch update multiple episodes
- Delete/modify recordings via API
- Scheduling recordings via HTTP

---

## API Endpoint Discovery Reference

### Useful Debugging Techniques

**Network Traffic Analysis:**
```bash
# Basic packet capture
sudo tcpdump -i any -A host {device_ip} and port 80

# Save to file for Wireshark
sudo tcpdump -i any -w capture.pcap host {device_ip}

# Filter for specific patterns
sudo tcpdump -i any -A 'tcp port 80' | grep -A 10 "cmd"
```

**HTTP Proxy Tools:**
- mitmproxy: `mitmproxy --mode transparent`
- Charles Proxy: GUI-based HTTP/HTTPS proxy
- Burp Suite: Security-focused proxy

**Browser DevTools:**
- Network tab → Right-click → Copy as cURL
- Preserve log to capture redirects
- Filter by XHR/Fetch for API calls

**Systematic API Testing Matrix:**
| Method | Body Type | Param Location | Result |
|--------|-----------|----------------|--------|
| GET | N/A | Query | X 400 |
| POST | Form | Body | X 400 |
| POST | JSON | Body | X 400 |
| POST | None | Query | O 200 |
| PUT | Form | Body | X Empty |

---

## Known HDHomeRun API Endpoints

### Reading Data

**Device Discovery:**
```
GET http://{device_ip}/discover.json
```

**Recorded Series:**
```
GET http://{device_ip}/recorded_files.json
```

**Series Episodes:**
```
GET http://{device_ip}/recorded/{series_id}.json
```

**Streaming:**
```
GET http://{device_ip}/recorded/play?id={episode_id}
```

### Writing Data

**Update Resume Position:**
```
POST http://{device_ip}/recorded/cmd?id={episode_id}&cmd=set&Resume={position}
```

**Mark as Watched:**
```
POST http://{device_ip}/recorded/cmd?id={episode_id}&cmd=set&Resume=4294967295
```

### Unknown/Untested

These endpoints likely exist but haven't been tested:

- Delete recording: `cmd=delete`?
- Schedule recording: `/tuner/` endpoints?
- Modify recording rules: Unknown
- Batch operations: Unknown

---

## Architecture Decisions

### Progress Tracking Strategy

**Decision:** Maintain both local database and device sync

**Rationale:**
- Local database provides fast access and offline capability
- Device sync ensures consistency with official apps
- Dual-write pattern: Update both on every change

**Implementation:**
1. Update local database first (always succeeds)
2. Attempt device sync (best effort)
3. Log warnings if device sync fails
4. Return success if database updated, regardless of device sync

**Trade-offs:**
- Fast local reads
- Works when device offline
- Consistent with official apps when online
- X Potential inconsistency if device sync fails
- X Slightly slower writes (two operations)

### Database Triggers vs. Application Logic

**Decision:** Use SQLite triggers for `episode_count` and statistics

**Rationale:**
- Ensures data integrity at database level
- Automatic updates without application code
- Survives application restarts
- Prevents stale counts from bugs

**Implementation:**
- Triggers on INSERT/UPDATE/DELETE of episodes
- Recalculate stats on server startup for safety
- `ensureTriggersExist()` for backward compatibility

---

## Performance Optimizations

### HLS Transcoding

**Bulk Conversion Caching:**
- Only pre-cache episodes from past 30 days
- Concurrent limit: 2 simultaneous transcodes
- Persistent state tracking with `transcode.json`
- Cleanup of abandoned transcodes on startup

**Metadata in Cache:**
Added to `transcode.json`:
- `showName`: Series title
- `episodeName`: Episode title
- `airDate`: Original air date

**Benefits:**
- Easy identification of cached content
- Debugging transcode issues
- Manual cache management

### Progress Comparison Tool

**Optimization:** Series-level caching

**Problem:** Comparing all episodes makes N HTTP requests to device

**Solution:**
- Cache series episode lists (one request per series)
- All episodes in same series use cached data
- Reduces 200+ requests to ~10-20 requests

**Implementation:**
```javascript
this.seriesCache = new Map();
// Cache keyed by series_id
```

---

## Future Development Ideas

### Priority: High

- [ ] Automatic progress sync on episode playback start/stop
- [ ] Webhook/callback for device-initiated updates
- [ ] Background sync job (periodic device → database sync)
- [ ] Conflict resolution (device vs database differs)

### Priority: Medium

- [ ] Recording schedule management via API
- [ ] Delete recordings via API
- [ ] Episode metadata editing
- [ ] Multi-device support and conflict handling

### Priority: Low

- [ ] Recording rules management
- [ ] Channel/guide data access
- [ ] Live TV streaming proxy
- [ ] DVR storage monitoring/alerts

---

## Testing Notes

### Manual Testing Commands

**Check device connectivity:**
```bash
curl -s http://192.168.0.37/discover.json | jq
```

**Test progress update:**
```bash
# Via device-progress tool
node src/device-progress.js set 135 1234

# Via API
curl -X PUT http://localhost:3000/api/episodes/135/progress \
  -H "Content-Type: application/json" \
  -d '{"position": 1234, "watched": false}'
```

**Compare all episodes:**
```bash
# Compare only (read-only)
node src/compare-progress.js

# Compare and sync mismatches
node src/compare-progress.js --sync-mismatched
```

**Database queries:**
```bash
# Check episode progress
sqlite3 tvhdhomerun.db "SELECT id, title, resume_position, watched FROM episodes WHERE id = 135"

# Check series stats
sqlite3 tvhdhomerun.db "SELECT title, episode_count, total_duration FROM series"
```

---

## Common Issues & Solutions

### Issue: `episode_count` always 0

**Cause:** Database triggers not created in existing databases

**Solution:**
- Added `ensureTriggersExist()` to check/create triggers on startup
- Added `recalculateSeriesStats()` to fix existing data
- Server runs both on startup automatically

### Issue: Device sync returns 400 Bad Request

**Cause:** Wrong API format (missing `cmd=set` parameter)

**Solution:** Use correct format:
```
POST /recorded/cmd?id={id}&cmd=set&Resume={position}
```

### Issue: resume_position returns null

**Cause:** Database query didn't use COALESCE

**Solution:** Updated all episode queries:
```sql
SELECT COALESCE(e.resume_position, 0) as resume_position
```

### Issue: Sync status always shows "out of sync"

**Cause:** Type comparison issue (boolean vs integer)

**Solution:** Convert to same type:
```javascript
const dbWatched = !!episode.watched; // Convert to boolean
```

---

## Notes for Future Contributors

### Code Style Preferences

1. **Always log important operations** - helps debugging in production
2. **Use console.log() for user-facing tools** - server uses `this.log()`
3. **COALESCE for nullable fields** - prevent null in API responses
4. **Graceful degradation** - local database works even if device offline

### Testing New Features

1. Test with real HDHomeRun device (not just mocks)
2. Check both success and failure cases
3. Verify database triggers still work
4. Test with server restart (ensure persistence)
5. Check logs for warnings/errors

### Documentation

- Update `CLAUDE.md` for new features
- Add examples to `README.md`
- Document API changes in this log
- Add JSDoc comments for complex functions

---

