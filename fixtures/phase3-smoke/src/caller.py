def callee():
    return 1


def target():
    return callee()


# This is the caller function
# It calls target()
# TODO: add docstring
# Reviewed
def caller():
    return target()
