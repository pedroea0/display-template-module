# Project library script (copied to ignition/script-python/ctg/helpers/code.py by migrate.test.mjs)
def enableWrites(component):
	component.props.setpoint = True
	component.props["showUnits"] = False

def setRange(chart, hours):
	chart.props.rangeHours = hours
	chart.props.timeRange.realtime.value = hours  # v2 key: not reported
