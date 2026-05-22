from data_rover.metamodel.schema import ElementType, Metamodel, PropertyDef
from data_rover.model.model import Model
from data_rover.validation.pipeline import default_pipeline


def test_default_pipeline_runs_all_first_cut_validators():
    mm = Metamodel(elements=[ElementType(name="Block", properties=[
        PropertyDef(name="name", datatype="string", multiplicity="1")])])
    model = Model(mm)
    model.create_element("Block")  # missing required name -> multiplicity error
    issues = default_pipeline().validate(model)
    assert any("name" in i.message for i in issues)
