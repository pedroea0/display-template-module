"""
SIMPLIFIED Gateway Script Console Test
========================================
This uses Ignition's built-in system.tag functions which are always available.
Copy and paste this into Gateway Script Console.
"""

# ========================================
# CONFIGURE YOUR TEST TAG HERE
# ========================================
TAG_PATH = "[default]test"  # Change this to your tag path
# Examples:
# TAG_PATH = "[default]MyTag"
# TAG_PATH = "[UPE_Extrusion_Provider]Folder/Temperature"

print("=" * 60)
print("TESTING TAG READ (Using system.tag functions)")
print("=" * 60)
print("Tag Path: " + TAG_PATH)
print("")

try:
    # Read the tag using Ignition's built-in function
    # This is the simplest way and works in Gateway scope
    result = system.tag.readBlocking([TAG_PATH])
    
    if result and len(result) > 0:
        qv = result[0]
        
        print("=" * 60)
        print("SUCCESS!")
        print("=" * 60)
        print("Value:     " + str(qv.value))
        print("Quality:   " + str(qv.quality))
        print("Timestamp: " + str(qv.timestamp))
        print("=" * 60)
        
        # Show if quality is good
        if qv.quality.isGood():
            print("\nQuality is GOOD - Tag read successful!")
        else:
            print("\nWARNING: Quality is " + str(qv.quality))
    else:
        print("ERROR: No results from tag read")
        
except Exception as e:
    print("\nERROR: " + str(e))
    import traceback
    traceback.print_exc()

print("\nTest complete!")


