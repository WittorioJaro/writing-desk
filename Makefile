.PHONY: test test-app test-server app install run server clean

# Everything: app unit tests (incl. two Macs syncing through the real Swift server), app end-to-end, server checks.
test: test-app test-server

test-app: app/node_modules
	cd app && npm test && npx electron test/e2e.js

test-server:
	swift run WritingDeskChecks

app/node_modules: app/package-lock.json
	cd app && npm ci
	touch app/node_modules

# Builds "app/dist/Writing Desk-darwin-arm64/Writing Desk.app"
app: app/node_modules
	cd app && npm run build

install: app
	-osascript -e 'quit app "Writing Desk"' 2>/dev/null
	rm -rf "/Applications/Writing Desk.app"
	ditto "app/dist/Writing Desk-darwin-arm64/Writing Desk.app" "/Applications/Writing Desk.app"
	open "/Applications/Writing Desk.app"

# Run from source (for development)
run: app/node_modules
	cd app && npx electron .

clean:
	rm -rf .build app/dist
