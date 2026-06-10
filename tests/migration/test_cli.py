from pathlib import Path

from data_rover.migration.__main__ import main

SAMPLES = Path(__file__).resolve().parents[2] / "migration"


def test_cli_writes_outputs_and_returns_zero(tmp_path, capsys):
    out_mm = tmp_path / "out.metamodel.yaml"
    out_model = tmp_path / "out.model.json"
    code = main(
        [
            "--old-metamodel",
            str(SAMPLES / "old_metamodel_sample.json"),
            "--old-model",
            str(SAMPLES / "old_model_sample.json"),
            "--out-metamodel",
            str(out_mm),
            "--out-model",
            str(out_model),
        ]
    )
    assert code == 0
    assert out_mm.exists() and out_model.exists()
    # a human-readable summary is printed
    assert "metamodel" in capsys.readouterr().out.lower()
