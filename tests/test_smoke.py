import data_rover


def test_package_imports():
    assert hasattr(data_rover, "__version__")
