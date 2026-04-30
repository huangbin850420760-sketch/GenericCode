const fs = require('fs');
const path = require('path');

// Load the compiled chatPanel.js and extract the html() method output
// by simulating what the webview would receive.
const chatPanelSrc = fs.readFileSync(__dirname + '/out/chatPanel.js', 'utf8');

// We need to find the loadAssistantParserSource function and the html template
// Let's just try to eval the relevant parts
// Actually, simpler: just extract the regex patterns from the webview code

// Find all regex literals in the compiled JS that are inside the webview template
// The webview code is inside a template literal in the html() method

// Let's look for the problematic regex by checking the compiled output
const lines = chatPanelSrc.split('\n');
for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Look for regex patterns that might be broken
    // A regex in JS starts with / and ends with / followed by flags
    // "Invalid regular expression: missing /" means a / was interpreted as regex start but never closed
    if (line.includes('\\\\s') || line.includes('\\\\n') || line.includes('\\\\/')) {
        console.log(`L${i+1}: ${line.substring(0, 200)}`);
    }
}
