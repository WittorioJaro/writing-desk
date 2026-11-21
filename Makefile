.PHONY: test app run clean
test:
	swift run WritingDeskChecks
app:
	./scripts/build-app.sh
run: app
	open build/WritingDesk.app
clean:
	rm -rf .build build
