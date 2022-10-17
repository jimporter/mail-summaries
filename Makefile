ADDON_NAME := mailsummaries
ADDON_VERSION := $(shell jq --raw-output '.version' src/manifest.json)

.PHONY: package
package:
	rm -f $(ADDON_NAME)-$(ADDON_VERSION).xpi
	cd src && zip -r ../$(ADDON_NAME)-$(ADDON_VERSION).xpi *
