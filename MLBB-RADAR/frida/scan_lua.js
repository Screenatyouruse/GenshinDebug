console.log("[*] Lua Scanner with Debug");

var debugStartTime = Date.now();
var debugRangesFound = false;
var debugScanStarted = false;

function scanAll() {
    console.log("[*] " + ((Date.now() - debugStartTime) / 1000).toFixed(1) + "s - Enumerating memory ranges...");
    
    Process.enumerateRanges({
        protection: 'rw-',
        coalesce: true
    }, function(ranges) {
        debugRangesFound = true;
        var elapsed = ((Date.now() - debugStartTime) / 1000).toFixed(1);
        console.log("[*] " + elapsed + "s - ✅ Found " + ranges.length + " rw- ranges");
        
        if (ranges.length === 0) {
            console.log("[!] No ranges found - game may not be ready");
            return;
        }

        var magics = ["1b 4c 75 61 51", "1b 4c 75 61"];
        var anchors = ["76 65 72 69 66 79 73 6f 00", "63 68 65 63 6b 6c 69 62 00"];
        var patterns = magics.concat(anchors);
        
        var totalScans = ranges.length * patterns.length;
        var completedScans = 0;
        var foundMatches = 0;
        var scanStartTime = Date.now();

        console.log("[*] " + ((Date.now() - debugStartTime) / 1000).toFixed(1) + "s - Total scans: " + totalScans);
        console.log("[*] Starting scans...");

        ranges.forEach(function(r) {
            patterns.forEach(function(pat) {
                try {
                    Memory.scan(r.base, r.size, pat, {
                        onMatch: function(addr, size) {
                            foundMatches++;
                            console.log("[HIT #" + foundMatches + "] " + pat + " @ " + addr);
                        },
                        onComplete: function() {
                            completedScans++;
                            if (completedScans === 1) {
                                console.log("[*] " + ((Date.now() - debugStartTime) / 1000).toFixed(1) + 
                                          "s - ✅ First scan completed!");
                            }
                            if (completedScans % 100 === 0 || completedScans === totalScans) {
                                var elapsed2 = ((Date.now() - scanStartTime) / 1000).toFixed(1);
                                var pct = (completedScans / totalScans * 100).toFixed(1);
                                console.log("[*] " + pct + "% (" + completedScans + "/" + totalScans + 
                                          ") - " + elapsed2 + "s scanning - " + foundMatches + " hits");
                            }
                            if (completedScans >= totalScans) {
                                var totalTime = ((Date.now() - debugStartTime) / 1000).toFixed(1);
                                console.log("[*] ========================================");
                                console.log("[*] ✅ SCAN COMPLETE in " + totalTime + "s!");
                                console.log("[*] Total matches: " + foundMatches);
                                console.log("[*] ========================================");
                            }
                        }
                    });
                } catch(e) {
                    completedScans++;
                    console.log("[!] Error on " + r.base + ": " + e.message);
                }
            });
        });
        
        console.log("[*] " + ((Date.now() - debugStartTime) / 1000).toFixed(1) + "s - All scans started");
        debugScanStarted = true;
        
    }, function(error) {
        // ERROR callback
        console.log("[!] ❌ enumerateRanges FAILED: " + error);
        console.log("[!] This is why nothing is happening!");
    });
}

console.log("[*] Waiting 3 seconds...");
setTimeout(function() {
    scanAll();
}, 3000);

// Keep alive and show heartbeat
var heartbeat = setInterval(function() {
    var elapsed = ((Date.now() - debugStartTime) / 1000).toFixed(1);
    console.log("[HEARTBEAT] " + elapsed + "s - Ranges found: " + debugRangesFound + 
               ", Scan started: " + debugScanStarted);
}, 10000); // Every 10 seconds

console.log("[*] Script loaded. Waiting for results...");
console.log("[*] If you see 'HEARTBEAT' messages, the script is still alive.");