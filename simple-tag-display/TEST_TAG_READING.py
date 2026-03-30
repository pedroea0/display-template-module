"""
Gateway Script Console Test Script
====================================
Copy and paste this into the Gateway Script Console to test tag reading
without installing the module.

Instructions:
1. Open Ignition Gateway web interface
2. Go to Config > Scripting > Script Console
3. Select "Gateway" scope
4. Paste this script
5. Modify the TAG_PATH variable to your test tag
6. Click "Run Script"
"""

import system
from com.inductiveautomation.ignition.common.tags.paths.parser import TagPathParser
from com.inductiveautomation.ignition.common.tags.model import SecurityContext
from java.util import Arrays
from java.util.concurrent import TimeUnit

# ========================================
# CONFIGURE YOUR TEST TAG HERE
# ========================================
TAG_PATH = "test"  # Change this to your tag path
# Examples:
# TAG_PATH = "[default]MyTag"
# TAG_PATH = "[UPE_Extrusion_Provider]Folder/Temperature"
# TAG_PATH = "MemoryTags/Tag1"

print("=" * 60)
print("TESTING TAG READ")
print("=" * 60)
print("Tag Path: " + TAG_PATH)
print("")

try:
    # Get the gateway context
    from com.inductiveautomation.ignition.gateway import IgnitionGateway
    context = IgnitionGateway.get()
    tagManager = context.getTagManager()
    
    # Parse the tag path
    fullTagPath = TagPathParser.parse(TAG_PATH)
    providerName = fullTagPath.getSource()
    
    if providerName is None or providerName == "":
        providerName = "default"
    
    print("Provider: " + providerName)
    
    # Get the tag provider
    provider = tagManager.getTagProvider(providerName)
    
    if provider is None:
        print("ERROR: Provider not found: " + providerName)
        print("\nAvailable providers:")
        for p in tagManager.getTagProviders():
            print("  - " + p.getName())
    else:
        print("Provider found: " + provider.getName())
        
        # Create tag path without provider prefix
        tagPathWithoutProvider = fullTagPath.toStringPartial()
        tagPath = TagPathParser.parse(tagPathWithoutProvider)
        
        print("Tag path (without provider): " + tagPathWithoutProvider)
        print("\nReading tag value...")
        
        # Read the tag value (THIS IS THE KEY LINE!)
        results = provider.readAsync(
            Arrays.asList(tagPath),
            SecurityContext.emptyContext()
        ).get(5, TimeUnit.SECONDS)
        
        if results is not None and len(results) > 0:
            qv = results[0]
            
            print("\n" + "=" * 60)
            print("SUCCESS!")
            print("=" * 60)
            print("Value:     " + str(qv.getValue()))
            print("Quality:   " + str(qv.getQuality()))
            print("Is Good:   " + str(qv.getQuality().isGood()))
            print("Timestamp: " + str(qv.getTimestamp()))
            print("=" * 60)
        else:
            print("ERROR: No results from tag read")

except Exception as e:
    print("\nERROR: " + str(e))
    import traceback
    traceback.print_exc()

print("\nTest complete!")

