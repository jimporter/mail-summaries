ADDON_NAME := mailsummaries
ADDON_VERSION := $(shell python -c "import json; print(json.load(open('src/manifest.json'))['version'])")

.PHONY: package
package:
	rm -f $(ADDON_NAME)-$(ADDON_VERSION).xpi
	cd src && zip -r ../$(ADDON_NAME)-$(ADDON_VERSION).xpi *
