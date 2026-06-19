import shutil
import pytest
from pptx_mcp.storage import Storage


@pytest.fixture
def storage(sample_template_dir, tmp_path_factory):
    # Create separate directories for this test
    tmp_path = tmp_path_factory.mktemp("storage_test")
    templates = tmp_path / "templates"
    templates.mkdir()
    shutil.copytree(sample_template_dir, templates / "sample")
    return Storage(templates, tmp_path / "out")


def test_list_template_ids(storage):
    assert storage.list_template_ids() == ["sample"]


def test_load(storage):
    assert storage.load("sample").id == "sample"


def test_put_and_resolve(storage):
    token = storage.put_output(b"hello", ".pptx")
    p = storage.path_for(token)
    assert p is not None and p.read_bytes() == b"hello"


def test_unknown_token(storage):
    assert storage.path_for("nope") is None
